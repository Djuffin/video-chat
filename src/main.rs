#![allow(dead_code)]
#![allow(unused_variables)]
use log::*;

use actix::prelude::*;
use actix::{Actor, StreamHandler};
use actix_files::Files;
use actix_http::ws::Codec;
use actix_service::Service;
use actix_web::http::{header::CACHE_CONTROL, header::LOCATION, HeaderValue};
use actix_web::web::Bytes;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer, Responder};
use actix_web_actors::ws;
use openssl::ssl::{SslAcceptor, SslFiletype, SslMethod};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

use std::collections::HashMap;

#[macro_use]
extern crate lazy_static;

// Messages
#[derive(Clone, Debug)]
struct VideoChunk {
    key_frame: bool,
    data: Bytes,
}

#[derive(Clone, Message, Debug)]
#[rtype(result = "()")]
enum CoordinatorMessage {
    Connect {
        id: u32,
        addr: Recipient<ClientMessage>,
    },
    Disconnect {
        id: u32,
    },
    Video {
        id: u32,
        chunk: VideoChunk,
    },
}

#[derive(Clone, Message, Debug)]
#[rtype(result = "()")]
enum ClientMessage {
    Video { id: u32, chunk: VideoChunk },
    Connect { id: u32 },
    Disconnect { id: u32 },
}

#[derive(Serialize, Deserialize, Debug)]
struct ClientCommand {
    action: &'static str,
    id: u32,
}

// Actors
#[derive(Default)]
struct Coordinator {
    clients: HashMap<u32, Recipient<ClientMessage>>,
}

struct Client {
    id: u32,
    coordinator: Recipient<CoordinatorMessage>,
}

impl Actor for Coordinator {
    type Context = Context<Self>;
}

impl Actor for Client {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let addr = ctx.address();
        let msg = CoordinatorMessage::Connect {
            id: self.id,
            addr: addr.recipient(),
        };
        if let Some(e) = self.coordinator.do_send(msg).err() {
            error!("Connecting error: {}", e);
        }
    }

    fn stopping(&mut self, _: &mut Self::Context) -> Running {
        let msg = CoordinatorMessage::Disconnect { id: self.id };
        if let Some(e) = self.coordinator.do_send(msg).err() {
            error!("Disconnecting error: {}", e);
        }
        Running::Stop
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for Client {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(msg)) => {
                ctx.pong(&msg);
            }
            Ok(ws::Message::Pong(_)) => {
                ctx.ping(b"");
            }
            Ok(ws::Message::Text(text)) => {}
            Ok(ws::Message::Binary(bin)) => {
                let key_frame = bin.get(0) != Some(&0);
                let mut total_data: Vec<u8> = Vec::new();
                total_data.extend_from_slice(&self.id.to_le_bytes());
                total_data.push(if key_frame { 1 } else { 0 });
                total_data.extend_from_slice(&bin.as_ref()[1..]);

                let video_chunk = VideoChunk {
                    key_frame: key_frame,
                    data: Bytes::from(total_data),
                };
                if let Some(e) = self
                    .coordinator
                    .do_send(CoordinatorMessage::Video {
                        id: self.id,
                        chunk: video_chunk,
                    })
                    .err()
                {
                    error!("Error sending video blob to coordinator {}", e);
                }
            }
            Ok(ws::Message::Continuation(cont)) => {
                error!("Continuation {:?}", cont);
            }
            Ok(ws::Message::Close(reason)) => {
                info!("Close: {:?}", reason);
                ctx.close(reason);
                ctx.stop();
            }
            _ => ctx.stop(),
        }
    }
}

impl Handler<ClientMessage> for Client {
    type Result = ();

    fn handle(&mut self, msg: ClientMessage, ctx: &mut Self::Context) {
        match msg {
            ClientMessage::Video { id, chunk } => {
                ctx.binary(chunk.data);
            }
            ClientMessage::Connect { id } => {
                let cmd = ClientCommand {
                    action: "connect",
                    id: id,
                };
                ctx.text(serde_json::to_string(&cmd).unwrap());
            }
            ClientMessage::Disconnect { id } => {
                let cmd = ClientCommand {
                    action: "disconnect",
                    id: id,
                };
                ctx.text(serde_json::to_string(&cmd).unwrap());
            }
        }
    }
}

impl Coordinator {
    fn send_all_client_except_one(&mut self, id: u32, msg: ClientMessage) {
        for (client_id, client) in self.clients.iter() {
            if *client_id == id {
                continue;
            }
            if let Some(e) = client.do_send(msg.clone()).err() {
                error!(
                    "Error sending message to client. id:{} error: {}",
                    client_id, e
                );
            }
        }
    }
}

impl Handler<CoordinatorMessage> for Coordinator {
    type Result = ();

    fn handle(&mut self, msg: CoordinatorMessage, ctx: &mut Self::Context) {
        match msg {
            CoordinatorMessage::Connect { id, addr } => {
                info!("Client connected {}", id);
                let existing_clients: Vec<u32> = self.clients.keys().cloned().collect();
                self.clients.insert(id, addr.clone());
                self.send_all_client_except_one(id, ClientMessage::Connect { id: id });
                for id in existing_clients {
                    let _ = addr.do_send(ClientMessage::Connect { id: id });
                }
            }
            CoordinatorMessage::Disconnect { id } => {
                info!("Client disconnected {}", id);
                self.clients.remove(&id);
                self.send_all_client_except_one(id, ClientMessage::Disconnect { id: id });
            }
            CoordinatorMessage::Video { id, chunk } => {
                self.send_all_client_except_one(
                    id,
                    ClientMessage::Video {
                        id: id,
                        chunk: chunk,
                    },
                );
            }
        }
    }
}

lazy_static! {
    static ref COUNTER: Mutex<u32> = Mutex::new(1);
}

fn get_next_client_id() -> u32 {
    let mut guard = COUNTER.lock().unwrap();
    let value = *guard;
    *guard += 1;
    value
}

#[actix_web::get("/")]
async fn redirect_to_spec() -> HttpResponse {
    HttpResponse::PermanentRedirect()
        .header(LOCATION, "https://www.w3.org/TR/webcodecs/")
        .finish()
}

async fn vc_socket_route(
    req: HttpRequest,
    stream: web::Payload,
    coordinator: web::Data<Addr<Coordinator>>,
) -> Result<HttpResponse, Error> {
    let id = get_next_client_id();
    let actor = Client {
        id: id,
        coordinator: coordinator.get_ref().clone().recipient(),
    };

    let mut res = ws::handshake(&req)?;
    let codec = Codec::new().max_size(1024 * 1024);
    Ok(res.streaming(ws::WebsocketContext::with_codec(actor, stream, codec)))
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let port = args
        .get(1)
        .unwrap_or(&"80".to_string())
        .parse::<u32>()
        .unwrap_or(80);

    env_logger::Builder::new()
        .filter(None, LevelFilter::Info)
        .init();

    let mut builder = SslAcceptor::mozilla_intermediate(SslMethod::tls()).unwrap();
    if Path::new("./key.pem").exists() && Path::new("./cert.pem").exists() {
        builder
            .set_private_key_file("key.pem", SslFiletype::PEM)
            .unwrap();
        builder.set_certificate_chain_file("cert.pem").unwrap();
    }

    let mut coordinators: Vec<Addr<Coordinator>> = vec![];
    for i in 0..5 {
        coordinators.push(Coordinator::default().start())
    }

    HttpServer::new(move || {
        let mut app = App::new().wrap_fn(|req, srv| {
            let fut = srv.call(req);
            async {
                let mut res = fut.await?;
                res.headers_mut()
                    .insert(CACHE_CONTROL, HeaderValue::from_static("no-cache"));
                Ok(res)
            }
        });

        for (i, coordinator) in coordinators.iter().enumerate() {
            app = app.service(
                web::resource(format!("/vc-room{}/", i))
                    .data(coordinator.clone())
                    .to(vc_socket_route),
            );
        }

        app.service(Files::new("/vc", "./static/").index_file("index.html"))
            .service(redirect_to_spec)
    })
    .bind(format!("0.0.0.0:{0}", port))?
    .bind_openssl("127.0.0.1:443", builder)?
    .run()
    .await
}
