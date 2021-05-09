'use strict';

class Interlocutor {
  id = 0;
  canvas = null;
  ctx = null;
  config = null;
  seen_keyframe = false;

  constructor(config, id, canvas) {
    this.id = id;
    this.config = config;

    this.canvas = canvas;
    this.ctx = this.canvas.getContext('2d');
  }

  render(frame) {
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
  }

  decode(data) {
    let view = new DataView(data);
    let id = view.getUint32(0, true);
    if (id != this.id)
      return;
    let keyframe = (view.getUint8(4) != 0);
    let video_data = new Uint8Array(data).subarray(5);

    if (!this.decoder) {
      this.decoder = new VideoDecoder({
        output: this.render.bind(this),
        error: this.onError.bind(this),
      });
      this.seen_keyframe = false;
    }

    if (!this.seen_keyframe) {
      if (!keyframe)
        return;
      this.seen_keyframe = true;
      this.decoder.configure(this.config);
    }

    let chunk = new EncodedVideoChunk({
      timestamp: performance.now() * 1000,
      type: keyframe ? 'key' : 'delta',
      data: video_data
    });
    this.decoder.decode(chunk);
  }

  close() {
    if (this.decoder)
      this.decoder.close();
  }

  onError(e) {
    console.log(e);
    this.decoder = null;
  }
}

class CanvasManager {
  parent = null;
  width = 720;
  height = 480;

  constructor(parent_id) {
    parent = document.getElementById(parent_id);
  }

  addCanvas(id) {
    let canvas = document.createElement("canvas");
    canvas.height = this.height;
    canvas.width = this.width;
    canvas.id = "interlocutor_" + id;
    canvas.classList.add('interlocutor');
    parent.appendChild(canvas);
    return canvas;
  }

  removeCanvas(id) {
    let canvas = document.getElementById("interlocutor_" + id);
    canvas.parentElement.removeChild(canvas);
  }

}

class ServerSocket {
  media_processor = null;
  track = null;
  encoder = null;
  socket = null;
  force_keyframe = true;
  keep_going = true;
  selfie = null;
  interlocutors = new Map();
  canvas_manager = null;
  config = null;

  constructor(track, config, canvas_manager) {
    const { location } = window;
    const proto = location.protocol.startsWith('https') ? 'wss' : 'ws';
    const uri = `${proto}://${location.host}/vs-socket/`;
    this.socket = new WebSocket(uri);
    this.socket.binaryType = 'arraybuffer';

    this.socket.onopen = () => {
      console.log("Connected to " + uri);
    };

    this.socket.onmessage = (ev) => {
      try {
        if (typeof (ev.data) == "string")
          this.processServerMessage(ev.data);
        else {
          this.processDataFromServer(ev.data);
        }
      }
      catch (e) {
        this.onError(e);
      }
    };

    this.socket.onerror = this.onError.bind(this);

    this.socket.onclose = () => {
      console.log('Disconnected from ' + uri);
      this.socket = null;
    };

    this.encoder = new VideoEncoder({
      output: this.onChunkReady.bind(this),
      error: this.onError.bind(this)
    });
    this.encoder.configure(config);

    this.config = config;
    this.canvas_manager = canvas_manager;
    this.track = track;
    this.media_processor = new MediaStreamTrackProcessor(track);
    this.reader = this.media_processor.readable.getReader();

    console.log(`ServerSocket created ${uri} ${JSON.stringify(config)}`);
  }

  setSelfieCanvas(canvas) {
    this.selfie = {
      canvas: canvas,
      context: canvas.getContext('2d')
    };
  }

  processDataFromServer(data) {
    let view = new DataView(data);
    let id = view.getUint32(0, true);
    let interlocutor = this.interlocutors.get(id);
    if (!interlocutor)
      return;
    interlocutor.decode(data);
  }

  processServerMessage(text) {
    console.log("Server message: " + text);
    let msg = JSON.parse(text);
    if (msg.action == 'disconnect') {
      let interlocutor = this.interlocutors.get(msg.id);
      if (!interlocutor)
        return;
      interlocutor.close();
      this.interlocutors.delete(msg.id);
      this.canvas_manager.removeCanvas(msg.id);
    } else if (msg.action == 'connect') {
      this.force_keyframe = true;
      let canvas = this.canvas_manager.addCanvas(msg.id);
      let interlocutor = new Interlocutor(this.config, msg.id, canvas);
      this.interlocutors.set(msg.id, interlocutor);
    }
  }

  async processFrames() {
    let counter = 0;
    while (this.keep_going) {
      counter++;
      if (counter % 100 == 0)
        this.force_keyframe = true;

      const result = await this.reader.read();
      let frame = result.value;
      if (this.selfie) {
        this.selfie.context.drawImage(frame, 0, 0, this.selfie.canvas.width,
          this.selfie.canvas.height);
      }

      let too_much_data_in_flight = this.socket.bufferedAmount > 1;
      if (this.socket.readyState == WebSocket.OPEN && !too_much_data_in_flight) {
        this.encoder.encode(frame, { keyFrame: this.force_keyframe });
        this.force_keyframe = false;
      }
      try {
        frame.close();
      } catch {
        // In case encode() closes frames
      }
    }
  }

  onChunkReady(chunk, md) {
    if (md.decoderConfig) {
      console.log(JSON.stringify(md.decoderConfig));
    }
    let key_frame_prefix = new Uint8Array([chunk.type == 'key' ? 1 : 0]);
    let blob = new Blob([key_frame_prefix, chunk.data]);
    if (this.socket) {
      this.socket.send(blob);
    }
  }

  onError(error) {
    console.log(error);
  }
}
