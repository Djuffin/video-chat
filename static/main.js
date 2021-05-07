'use strict';

class VideoRenderer {
  canvas = null;
  ctx = null;

  constructor(canvas_id) {
    this.canvas = document.getElementById(canvas_id);
    this.ctx = this.canvas.getContext('2d');
  }

  show(frame) {
    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    frame.close();
  }
}

class RtcDecoder {
  constructor(config, frame_callback, error_callback) {
    this.config = config;
    this.frame_callback = frame_callback;
    this.error_callback = error_callback;

    this.decoder = new VideoDecoder({
      output: frame_callback,
      error: error_callback
    });
    this.decoder.configure(config);
  }

  async decode(blob) {
    let chunk = new EncodedVideoChunk({
      timestamp: performance.now() * 1000,
      type: 'key',
      data: await blob.arrayBuffer()
    });
    this.decoder.decode(chunk);
  }
}

class VideoSocket {
  reader = null;
  media_processor = null;
  track = null;
  encoder = null;
  socket = null;
  keep_going = true;

  constructor(name, track, config, data_callback) {
    const { location } = window;
    const proto = location.protocol.startsWith('https') ? 'wss' : 'ws';
    const uri = `${proto}://${location.host}/${name}/`;
    this.socket = new WebSocket(uri);
    this.data_callback = data_callback;

    this.socket.onopen = () => {
      console.log("Connected...");
      this.processFrames();
    };

    this.socket.onmessage = (ev) => {
      if (typeof(ev.data) == "string")
        console.log(ev.data);
      else
        this.data_callback(ev.data);
    };

    this.socket.onclose = () => {
      console.log('Disconnected...')
    };

    this.encoder = new VideoEncoder({
      output: this.onChunkReady.bind(this),
      error: this.onError.bind(this)
    });
    this.encoder.configure(config);

    this.track = track;
    this.media_processor = new MediaStreamTrackProcessor(track);
    this.reader = this.media_processor.readable.getReader();

    console.log(`VideoSocket created ${name} ${JSON.stringify(config)}`);
  }

  async processFrames() {
    let counter = 0;
    while (this.keep_going) {
      try {
        const result = await this.reader.read();
        let frame = result.value;
        let keyFrame = (counter % 300 == 0);
        counter++;
        this.encoder.encode(frame, { keyFrame: keyFrame });
        frame.close();
      }
      catch (e) {
        onError(e);
      }
    }
  }

  onChunkReady(chunk, md) {
    if (chunk.type == 'key')
      this.socket.send('key');

    this.socket.send(chunk.data);
  }

  onError(error) {
    console.log(error);
    this.keep_going = false;
  }
}