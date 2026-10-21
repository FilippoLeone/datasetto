/* tslint:disable */
/* eslint-disable */

export class DeepFilter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Samples per hop: the length of the input and output buffers.
     */
    frame_length(): number;
    /**
     * Pointer into WebAssembly memory where the caller writes the next hop.
     */
    input_ptr(): number;
    /**
     * Model lookahead in hops (algorithmic delay = lookahead * frame_length samples).
     */
    lookahead(): number;
    /**
     * Loads a DeepFilterNet model from the bytes of its `*_onnx.tar.gz` archive.
     *
     * `atten_lim_db` limits how much noise is removed (100 = unlimited).
     * The three thresholds choose, per frame and from the model's local SNR
     * estimate, which stages run: below `min_db_thresh` the frame is treated as
     * noise only, above `max_db_erb_thresh` it is passed through untouched, and
     * above `max_db_df_thresh` only the first (ERB gain) stage runs. Passing
     * `-inf`, `inf`, `inf` runs both stages on every frame, like the PyTorch
     * reference implementation.
     */
    constructor(model_bytes: Uint8Array, atten_lim_db: number, min_db_thresh: number, max_db_erb_thresh: number, max_db_df_thresh: number);
    /**
     * Pointer into WebAssembly memory where the enhanced hop is written.
     */
    output_ptr(): number;
    /**
     * Enhances the hop in the input buffer into the output buffer and returns
     * the local SNR estimate for the frame in dB.
     */
    process(): number;
    /**
     * Sample rate the model expects.
     */
    sample_rate(): number;
    /**
     * Changes the attenuation limit in dB (100 = unlimited).
     */
    set_atten_lim(lim_db: number): void;
    /**
     * Post filter strength; 0 disables it, 0.02 is the upstream default when on.
     */
    set_post_filter_beta(beta: number): void;
    /**
     * Changes the stage thresholds (see `new`).
     */
    set_thresholds(min_db_thresh: number, max_db_erb_thresh: number, max_db_df_thresh: number): void;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_deepfilter_free: (a: number, b: number) => void;
    readonly deepfilter_frame_length: (a: number) => number;
    readonly deepfilter_input_ptr: (a: number) => number;
    readonly deepfilter_lookahead: (a: number) => number;
    readonly deepfilter_new: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number];
    readonly deepfilter_output_ptr: (a: number) => number;
    readonly deepfilter_process: (a: number) => [number, number, number];
    readonly deepfilter_sample_rate: (a: number) => number;
    readonly deepfilter_set_atten_lim: (a: number, b: number) => void;
    readonly deepfilter_set_post_filter_beta: (a: number, b: number) => void;
    readonly deepfilter_set_thresholds: (a: number, b: number, c: number, d: number) => void;
    readonly __wbindgen_exn_store_command_export: (a: number) => void;
    readonly __externref_table_alloc_command_export: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
    readonly __externref_table_dealloc_command_export: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
