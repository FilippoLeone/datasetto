// AudioWorkletGlobalScope has no TextDecoder, TextEncoder, URL or crypto. The wasm-bindgen glue
// touches TextDecoder at load time and the Rust side asks crypto for random bytes once, so give
// it minimal stand-ins. None of them is on the audio path.
if (typeof globalThis.TextDecoder === 'undefined') {
  globalThis.TextDecoder = class {
    constructor() { this.encoding = 'utf-8'; }
    decode(input) {
      if (!input) return '';
      const bytes = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
      let out = '';
      for (let i = 0; i < bytes.length; ) {
        const c = bytes[i++];
        if (c < 0x80) out += String.fromCharCode(c);
        else if (c < 0xe0) out += String.fromCharCode(((c & 0x1f) << 6) | (bytes[i++] & 0x3f));
        else if (c < 0xf0) out += String.fromCharCode(((c & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
        else {
          const cp = (((c & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f)) - 0x10000;
          out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        }
      }
      return out;
    }
  };
}
if (typeof globalThis.TextEncoder === 'undefined') {
  globalThis.TextEncoder = class {
    constructor() { this.encoding = 'utf-8'; }
    encode(text = '') {
      const out = [];
      for (let i = 0; i < text.length; i++) {
        let c = text.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
        else if (c >= 0xd800 && c < 0xdc00) {
          const c2 = text.charCodeAt(++i);
          c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
          out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
      return Uint8Array.from(out);
    }
    encodeInto(text, target) {
      const bytes = this.encode(text);
      target.set(bytes.subarray(0, target.length));
      return { read: text.length, written: Math.min(bytes.length, target.length) };
    }
  };
}
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = {
    getRandomValues(array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return array;
    },
  };
}
if (typeof globalThis.URL === 'undefined') {
  globalThis.URL = class { constructor(href) { this.href = String(href); } toString() { return this.href; } };
}
