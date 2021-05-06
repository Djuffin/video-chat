use log::*;
use std::time::{Duration, Instant};

use actix::prelude::*;
use actix::{Actor, StreamHandler};
use actix_files::Files;
use actix_web::{web, App, Error, HttpRequest, HttpResponse, HttpServer};
use actix_web_actors::ws;

use std::collections::{HashMap, HashSet};

struct VideoChatSocket {
}

impl Actor for VideoChatSocket {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, _ctx: &mut Self::Context) {
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for VideoChatSocket {
    fn handle(
        &mut self,
        msg: Result<ws::Message, ws::ProtocolError>,
        ctx: &mut Self::Context,
    ) {
        match msg {
            Ok(ws::Message::Ping(msg)) => {
                info!("ping");
                ctx.pong(&msg);
            }
            Ok(ws::Message::Pong(_)) => {
                info!("pong");
            }
            Ok(ws::Message::Text(text)) => {
                info!("Text: {}", text);
                ctx.text(text);
            }
            Ok(ws::Message::Binary(bin)) => {
                info!("Binary: {}", bin.len());
                ctx.binary(bin);
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

impl VideoChatSocket {
    fn new() -> Self {
        Self {  }
    }
}

async fn chat_route(req: HttpRequest, stream: web::Payload) -> Result<HttpResponse, Error> {
    ws::start(VideoChatSocket::new(), &req, stream)
}

#[actix_web::main]
async fn main() -> std::io::Result<()> {
    env_logger::Builder::new()
        .filter(None, LevelFilter::Info)
        .init();

    let addr = "127.0.0.1:8080";
    let srv = HttpServer::new(move || {
        App::new()
            .service(web::resource("/ws/").to(chat_route))
            .service(Files::new("/", "./static/").index_file("index.html"))
    })
    .bind(&addr)?;
    srv.run().await
}
