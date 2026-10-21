//! WebAssembly bindings for libDF, written for an AudioWorklet caller.
//!
//! The caller writes one hop (480 samples at 48 kHz) into the buffer behind
//! `input_ptr()`, calls `process()`, and reads the enhanced hop from the buffer
//! behind `output_ptr()`. No allocation happens per frame. `process()` returns
//! the model's local SNR estimate for the frame, in dB, which a gate can use as
//! a speech activity signal.

use tract_core::ndarray::prelude::*;
use wasm_bindgen::prelude::*;

use crate::tract::*;

#[wasm_bindgen]
pub struct DeepFilter {
    model: DfTract,
    input: Vec<f32>,
    output: Vec<f32>,
}

#[wasm_bindgen]
impl DeepFilter {
    /// Loads a DeepFilterNet model from the bytes of its `*_onnx.tar.gz` archive.
    ///
    /// `atten_lim_db` limits how much noise is removed (100 = unlimited).
    /// The three thresholds choose, per frame and from the model's local SNR
    /// estimate, which stages run: below `min_db_thresh` the frame is treated as
    /// noise only, above `max_db_erb_thresh` it is passed through untouched, and
    /// above `max_db_df_thresh` only the first (ERB gain) stage runs. Passing
    /// `-inf`, `inf`, `inf` runs both stages on every frame, like the PyTorch
    /// reference implementation.
    #[wasm_bindgen(constructor)]
    pub fn new(
        model_bytes: &[u8],
        atten_lim_db: f32,
        min_db_thresh: f32,
        max_db_erb_thresh: f32,
        max_db_df_thresh: f32,
    ) -> Result<DeepFilter, JsError> {
        let r_params = RuntimeParams::default_with_ch(1)
            .with_atten_lim(atten_lim_db)
            .with_thresholds(min_db_thresh, max_db_erb_thresh, max_db_df_thresh);
        let df_params = DfParams::from_bytes(model_bytes)
            .map_err(|e| JsError::new(&format!("Could not read the DeepFilterNet model: {e}")))?;
        let model = DfTract::new(df_params, &r_params)
            .map_err(|e| JsError::new(&format!("Could not initialize DeepFilterNet: {e}")))?;
        let hop = model.hop_size;
        Ok(DeepFilter {
            model,
            input: vec![0.0; hop],
            output: vec![0.0; hop],
        })
    }

    /// Samples per hop: the length of the input and output buffers.
    pub fn frame_length(&self) -> usize {
        self.model.hop_size
    }

    /// Sample rate the model expects.
    pub fn sample_rate(&self) -> usize {
        self.model.sr
    }

    /// Model lookahead in hops (algorithmic delay = lookahead * frame_length samples).
    pub fn lookahead(&self) -> usize {
        self.model.lookahead
    }

    /// Pointer into WebAssembly memory where the caller writes the next hop.
    pub fn input_ptr(&mut self) -> *mut f32 {
        self.input.as_mut_ptr()
    }

    /// Pointer into WebAssembly memory where the enhanced hop is written.
    pub fn output_ptr(&mut self) -> *mut f32 {
        self.output.as_mut_ptr()
    }

    /// Enhances the hop in the input buffer into the output buffer and returns
    /// the local SNR estimate for the frame in dB.
    pub fn process(&mut self) -> Result<f32, JsError> {
        let hop = self.model.hop_size;
        let input = ArrayView2::from_shape((1, hop), &self.input[..])
            .map_err(|e| JsError::new(&format!("Bad input shape: {e}")))?;
        let output = ArrayViewMut2::from_shape((1, hop), &mut self.output[..])
            .map_err(|e| JsError::new(&format!("Bad output shape: {e}")))?;
        self.model
            .process(input, output)
            .map_err(|e| JsError::new(&format!("DeepFilterNet frame failed: {e}")))
    }

    /// Changes the attenuation limit in dB (100 = unlimited).
    pub fn set_atten_lim(&mut self, lim_db: f32) {
        self.model.set_atten_lim(lim_db)
    }

    /// Post filter strength; 0 disables it, 0.02 is the upstream default when on.
    pub fn set_post_filter_beta(&mut self, beta: f32) {
        self.model.set_pf_beta(beta)
    }

    /// Changes the stage thresholds (see `new`).
    pub fn set_thresholds(&mut self, min_db_thresh: f32, max_db_erb_thresh: f32, max_db_df_thresh: f32) {
        self.model.min_db_thresh = min_db_thresh;
        self.model.max_db_erb_thresh = max_db_erb_thresh;
        self.model.max_db_df_thresh = max_db_df_thresh;
    }
}
