# Neural noise suppression: third-party notices

The "Strong" noise suppression level runs two neural noise suppressors inside the browser, in an
AudioWorklet. Nothing here talks to a server: the files below are bundled with the client and the
audio never leaves the device.

## DeepFilterNet3 (`deepfilternet3.wasm`, `deepfilternet3-glue.js`, `deepfilternet3.model`)

- Source: https://github.com/Rikorose/DeepFilterNet (Hendrik Schröter), commit
  `d375b2d8309e0935d165700c91da9de862a99c31` (main, 2024-10-17).
- `deepfilternet3.wasm` is libDF (the Rust implementation, crate `deep_filter`) compiled to
  WebAssembly with the wrapper in `libdf/wasm.rs` and the tract upgrade in
  `libdf/deepfilternet-tract-0.23.patch` (from https://github.com/workadventure/noise-suppression,
  MIT). `deepfilternet3-glue.js` is the wasm-bindgen output. See `libdf/README.md` for the exact build.
- Licence of the code: dual MIT OR Apache-2.0, at your option
  (`libdf/LICENSE-MIT.deepfilternet`, `libdf/LICENSE-APACHE.deepfilternet`).
- `deepfilternet3.model` is `models/DeepFilterNet3_onnx.tar.gz` from that repository, unchanged
  (renamed so no server treats it as a compressed response). The repository's README says that
  "all code in this repository is dual-licensed under either MIT or Apache-2.0"; the model files
  under `models/` carry no separate licence statement of their own. The model is therefore kept as a
  separately served asset with this notice rather than compiled into the WebAssembly module.
- Paper: H. Schröter, A. N. Escalante-B., T. Rosenkranz, A. Maier, "DeepFilterNet2: Towards Real-Time
  Speech Enhancement on Embedded Devices for Full-Band Audio", IWAENC 2022; and "DeepFilterNet: Perceptually
  Motivated Real-Time Speech Enhancement", Interspeech 2023 (DeepFilterNet3).

## RNNoise (`rnnoise.wasm`)

- RNNoise by Jean-Marc Valin and the Xiph.Org Foundation, https://github.com/xiph/rnnoise, version 0.2
  with its 2024 model, licensed under the BSD 3-Clause licence (`LICENSE-BSD.rnnoise`).
- The WebAssembly build is the one shipped in the npm package `@shiguredo/rnnoise-wasm` 2025.1.5
  (Shiguredo Inc., Apache-2.0, `LICENSE-APACHE.shiguredo-rnnoise-wasm`), extracted from its
  `dist/rnnoise.js` where it is embedded as base64. Only the `.wasm` is used; the package's JavaScript
  wrapper is replaced by the small import shim in `../worklets/parts/rnnoise-processor.js`.

## tract

The DeepFilterNet3 module embeds tract 0.23.8 (https://github.com/sonos/tract, Sonos Inc.), dual
MIT OR Apache-2.0, as the ONNX inference engine, plus its Rust dependencies under their respective
MIT/Apache-2.0/BSD licences.
