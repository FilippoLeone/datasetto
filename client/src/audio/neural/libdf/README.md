# Building `deepfilternet3.wasm`

The WebAssembly module is libDF from https://github.com/Rikorose/DeepFilterNet compiled with
`wasm-pack`. It is checked in because the build needs a Rust toolchain; rebuild it only when
changing `wasm.rs` or bumping the upstream commit.

```sh
# Rust 1.91 or newer (tract 0.23.8 needs it) with the wasm32 target, and wasm-pack 0.13.
rustup toolchain install 1.91.0 --target wasm32-unknown-unknown
curl -L https://github.com/Rikorose/DeepFilterNet/archive/d375b2d8309e0935d165700c91da9de862a99c31.tar.gz | tar xz
cd DeepFilterNet-d375b2d8309e0935d165700c91da9de862a99c31
git apply <client>/src/audio/neural/libdf/deepfilternet-tract-0.23.patch
cp <client>/src/audio/neural/libdf/wasm.rs libDF/src/wasm.rs
cat >> libDF/Cargo.toml <<'EOF'

[package.metadata.wasm-pack.profile.release]
wasm-opt = ["-O3", "--enable-simd", "--enable-bulk-memory", "--enable-nontrapping-float-to-int"]
EOF
cargo update -p tract-core -p tract-data -p tract-hir -p tract-linalg -p tract-nnef -p tract-onnx -p tract-onnx-opl -p tract-pulse -p tract-pulse-opl
cargo update -p js-sys --precise 0.3.95
cargo update -p wasm-bindgen --precise 0.2.118
RUSTUP_TOOLCHAIN=1.91.0 RUSTFLAGS="-C target-feature=+simd128" \
  wasm-pack build libDF --target web --release --out-dir pkg --no-default-features --features wasm
cp libDF/pkg/df_bg.wasm <client>/src/audio/neural/deepfilternet3.wasm
cp libDF/pkg/df.js <client>/src/audio/neural/deepfilternet3-glue.js
cp models/DeepFilterNet3_onnx.tar.gz <client>/src/audio/neural/deepfilternet3.model
cd <client> && npm run build:worklets
```

On Windows the MSVC linker fails with `LNK1104` on the build-script executables when the cargo
target directory has a long path; set `CARGO_TARGET_DIR` to something short such as
`%LOCALAPPDATA%\Temp\dfn-wasm-target`.

What the patch does (from workadventure/noise-suppression, MIT): tract 0.21.4 -> 0.23.8, pinned,
because 0.21.x has no WebAssembly SIMD kernels and 0.23 is about 2.8x faster per frame; it also
drops the `default-model` feature (the model is passed to the constructor instead of being compiled
into the module) and enables the browser backend of getrandom 0.4, which tract 0.23 pulls in.

`wasm.rs` replaces the upstream bindings with a pointer-based frame API for the worklet (no
allocation per frame), returns the model's local SNR estimate per frame for the speech gate, and
exposes the attenuation limit, post filter and the three stage thresholds. The thresholds default
to "run both stages on every frame" in the worklet: libDF's own defaults (-10, 30, 20 dB) skip the
deep-filter stage on frames the model estimates as fairly clean, which the harness measured as a
loss of speech energy between 1 and 4 kHz.
