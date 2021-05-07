#![allow(dead_code)]
#![allow(unused_variables)]
use log::*;

use actix::prelude::*;
use actix::{Actor, StreamHandler};
use actix_files::Files;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer};
use actix_web_actors::ws;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use actix_web::web::Bytes;

use std::collections::HashMap;

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
        id: u64,
        addr: Recipient<ClientMessage>,
    },
    Disconnect {
        id: u64,
    },
    Video {
        id: u64,
        chunk: VideoChunk,
    },
}

#[derive(Clone, Message, Debug)]
#[rtype(result = "()")]
enum ClientMessage {
    Video { id: u64, chunk: VideoChunk },
}

// Actors
#[derive(Default)]
struct Coordinator {
    clients: HashMap<u64, Recipient<ClientMessage>>,
}

struct Client {
    id: u64,
    coordinator: Recipient<CoordinatorMessage>,
}

impl Actor for Coordinator {
    type Context = Context<Self>;
}

impl Actor for Client {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        let addr = ctx.address();
        if let Some(e) = self
            .coordinator
            .do_send(CoordinatorMessage::Connect {
                id: self.id,
                addr: addr.recipient(),
            })
            .err()
        {
            error!("Connecting error: {}", e);
        }
    }

    fn stopping(&mut self, _: &mut Self::Context) -> Running {
        if let Some(e) = self
            .coordinator
            .do_send(CoordinatorMessage::Disconnect { id: self.id })
            .err()
        {
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
            }
            Ok(ws::Message::Text(text)) => {}
            Ok(ws::Message::Binary(bin)) => {
                if let Some(e) = self
                    .coordinator
                    .do_send(CoordinatorMessage::Video {
                        id: self.id,
                        chunk: VideoChunk {
                            key_frame: true,
                            data: bin,
                        },
                    })
                    .err()
                {
                    error!("Error sending video blob to coordinator {}", e);
                }
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
                if chunk.key_frame {
                    ctx.text("key!");
                }
                ctx.binary(chunk.data);
            }
        }
    }
}

impl Handler<CoordinatorMessage> for Coordinator {
    type Result = ();

    fn handle(&mut self, msg: CoordinatorMessage, ctx: &mut Self::Context) {
        match msg {
            CoordinatorMessage::Connect { id, addr } => {
                self.clients.insert(id, addr);
            }
            CoordinatorMessage::Disconnect { id } => {
                self.clients.remove(&id);
            }
            CoordinatorMessage::Video { id, chunk } => {
                for (client_id, client) in self.clients.iter() {
                    if *client_id == id {
                        continue;
                    }
                    if let Some(e) = client
                        .do_send(ClientMessage::Video {
                            id: id,
                            chunk: chunk.clone(),
                        })
                        .err()
                    {
                        error!("Error sending video blob to client {}", e);
                    }
                }
            }
        }
    }
}

async fn websocket_rout(
    req: HttpRequest,
    stream: web::Payload,
    coordinator: web::Data<Addr<Coordinator>>,
) -> Result<HttpResponse, Error> {
    let mut hasher = DefaultHasher::new();
    req.peer_addr().hash(&mut hasher);
    let id = hasher.finish();
    ws::start(
        Client {
            id: id,
            coordinator: coordinator.get_ref().clone().recipient(),
        },
        &req,
        stream,
    )
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::Builder::new()
        .filter(None, LevelFilter::Info)
        .init();

    let addr = "127.0.0.1:8080";
    let coordinator = Coordinator::default().start();
    let srv = HttpServer::new(move || {
        App::new()
            .data(coordinator.clone())
            .service(web::resource("/ws/").to(websocket_rout))
            .service(Files::new("/", "./static/").index_file("index.html"))
    })
    .bind(&addr)?;
    srv.run().await
}
