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

    var scale = window.devicePixelRatio;
    this.canvas.width = config.visibleRegion.width / scale;
    this.canvas.height = config.visibleRegion.height / scale;

    this.ctx = this.canvas.getContext('2d');
    this.ctx.scale(1.0 / scale, 1.0 / scale);
  }

  render(frame) {
    this.ctx.drawImage(frame, 0, 0, this.config.visibleRegion.width,
                       this.config.visibleRegion.height);
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

  constructor(parent_id) {
    parent = document.getElementById(parent_id);
  }

  addCanvas(id) {
    let canvas = document.createElement("canvas");
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

function delay(time_ms) {
  return new Promise((resolve, reject) => {
    setTimeout(resolve, time_ms);
  });
};

class BandwidthCounter {
  upload_bytes = 0;
  download_bytes = 0;
  last_timestamp = 0;
  dropped_frames = 0;
  usage = { upload_kbps: 0, download_kbps: 0, dropped_frames: 0 };
  keep_going = true;

  constructor(stats_id) {
    this.last_timestamp = performance.now();
    this.stats_div = document.getElementById(stats_id);
  }

  reportUpload(bytes) {
    this.upload_bytes += bytes;
  }

  reportDownload(bytes) {
    this.download_bytes += bytes;
  }

  reportDroppedFrame() {
    this.usage.dropped_frames++;
  }

  async start() {
    this.upload_bytes = 0;
    this.download_bytes = 0;
    this.keep_going = true;

    while (this.keep_going) {
      let now = performance.now();
      let time_passed_sec = (now - this.last_timestamp) / 1000;
      this.last_timestamp = now;
      this.usage.download_kbps = this.download_bytes * 8 / 1000 / time_passed_sec;
      this.usage.upload_kbps = this.upload_bytes * 8 / 1000 / time_passed_sec;
      this.download_bytes = 0;
      this.upload_bytes = 0;
      this.showStats();
      await delay(1000);
    }
  }

  showStats() {
    if (this.stats_div) {
      let down = Math.round(this.usage.download_kbps);
      let up = Math.round(this.usage.upload_kbps);
      let drop_count = this.usage.dropped_frames;
      let text = `UP : ${up}Kbps DOWN : ${down}Kbps DROP: ${drop_count}`;
      this.stats_div.textContent = text;
    }
  }

  getBandwidthUsage() {
    return this.usage;
  }

  stop() {
    this.keep_going = false;
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
  encoder_config = null;
  decoder_config = null;


  constructor(room, track, encoder_config, decoder_config, canvas_manager, stats_id) {
    const { location } = window;
    const proto = location.protocol.startsWith('https') ? 'wss' : 'ws';
    const uri = `${proto}://${location.host}/vc-${room}/`;
    this.socket = new WebSocket(uri);
    this.socket.binaryType = 'arraybuffer';
    this.bw_counter = new BandwidthCounter(stats_id);

    this.socket.onopen = () => {
      console.log("Connected to " + uri);
      this.bw_counter.start();
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
      this.bw_counter.stop();
    };

    this.encoder = new VideoEncoder({
      output: this.onChunkReady.bind(this),
      error: this.onError.bind(this)
    });
    this.encoder.configure(encoder_config);

    this.encoder_config = encoder_config;
    this.decoder_config = decoder_config;
    this.canvas_manager = canvas_manager;
    this.track = track;
    this.media_processor = new MediaStreamTrackProcessor(track);
    this.reader = this.media_processor.readable.getReader();

    console.log(`ServerSocket created ${uri}`);
    console.log(`Encoder config ${JSON.stringify(this.encoder_config)}`);
    console.log(`Decoder config ${JSON.stringify(this.decoder_config)}`);
  }

  setSelfieCanvas(canvas) {
    this.selfie = {
      canvas: canvas,
      context: canvas.getContext('2d')
    };
    var scale = window.devicePixelRatio;
    this.selfie.canvas.width = this.encoder_config.width / scale;
    this.selfie.canvas.height = this.encoder_config.height / scale;
    this.selfie.context.scale(1.0 / scale, 1.0 / scale);
  }

  processDataFromServer(data) {
    this.bw_counter.reportDownload(data.byteLength);
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
      let interlocutor = new Interlocutor(this.decoder_config, msg.id, canvas);
      this.interlocutors.set(msg.id, interlocutor);
    }
  }

  renderSelfie(frame) {
    if (!this.selfie)
      return frame;
    this.selfie.context.drawImage(frame, 0, 0, this.encoder_config.width,
                                  this.encoder_config.height);
  }

  toggleWatermark() {
    if (this.watermark) {
      this.watermark = null;
      return false;
    } else {
      this.watermark = {
        canvas: new OffscreenCanvas(this.encoder_config.width,
                                    this.encoder_config.height)
      };
      this.watermark.context = this.watermark.canvas.getContext('2d')
      return true;
    }
  }

  addWatermark(frame) {
    if (!this.selfie || !this.watermark)
      return frame;
    let ctx = this.watermark.context;
    ctx.globalAlpha = 0.3;
    ctx.drawImage(frame, 0, 0, this.encoder_config.width,
                  this.encoder_config.height);
    ctx.font = '14px monospace';
    ctx.fillText("🎞️WebCodecs", 5, 25);
    ctx.fillStyle = "#2A252C";
    let result = new VideoFrame(this.watermark.canvas, { timestamp: frame.timestamp });
    frame.close();
    return result;
  }

  async processFrames() {
    let counter = 0;
    while (this.keep_going) {
      counter++;
      if (counter % 120 == 0)
        this.force_keyframe = true;

      const result = await this.reader.read();
      let frame = result.value;
      frame = this.addWatermark(frame);
      this.renderSelfie(frame);

      const dropThreshold = 15 * 1024; //15Kb
      let dropFrame = this.socket.bufferedAmount > dropThreshold;
      if (dropFrame) {
        this.bw_counter.reportDroppedFrame();
      } else if (this.socket.readyState == WebSocket.OPEN && !dropFrame) {
        if (this.force_keyframe)
          console.log("keyframe!");
        this.encoder.encode(frame, { keyFrame: this.force_keyframe });
        this.force_keyframe = false;
      }
      frame.close();
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
      this.bw_counter.reportUpload(blob.size);
    }
  }

  onError(error) {
    console.log(error);
  }
}
