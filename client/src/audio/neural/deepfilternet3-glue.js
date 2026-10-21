/* @ts-self-types="./df.d.ts" */

export class DeepFilter {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        DeepFilterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_deepfilter_free(ptr, 0);
    }
    /**
     * Samples per hop: the length of the input and output buffers.
     * @returns {number}
     */
    frame_length() {
        const ret = wasm.deepfilter_frame_length(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer into WebAssembly memory where the caller writes the next hop.
     * @returns {number}
     */
    input_ptr() {
        const ret = wasm.deepfilter_input_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Model lookahead in hops (algorithmic delay = lookahead * frame_length samples).
     * @returns {number}
     */
    lookahead() {
        const ret = wasm.deepfilter_lookahead(this.__wbg_ptr);
        return ret >>> 0;
    }
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
     * @param {Uint8Array} model_bytes
     * @param {number} atten_lim_db
     * @param {number} min_db_thresh
     * @param {number} max_db_erb_thresh
     * @param {number} max_db_df_thresh
     */
    constructor(model_bytes, atten_lim_db, min_db_thresh, max_db_erb_thresh, max_db_df_thresh) {
        const ptr0 = passArray8ToWasm0(model_bytes, wasm.__wbindgen_malloc_command_export);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.deepfilter_new(ptr0, len0, atten_lim_db, min_db_thresh, max_db_erb_thresh, max_db_df_thresh);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0] >>> 0;
        DeepFilterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Pointer into WebAssembly memory where the enhanced hop is written.
     * @returns {number}
     */
    output_ptr() {
        const ret = wasm.deepfilter_output_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Enhances the hop in the input buffer into the output buffer and returns
     * the local SNR estimate for the frame in dB.
     * @returns {number}
     */
    process() {
        const ret = wasm.deepfilter_process(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * Sample rate the model expects.
     * @returns {number}
     */
    sample_rate() {
        const ret = wasm.deepfilter_sample_rate(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Changes the attenuation limit in dB (100 = unlimited).
     * @param {number} lim_db
     */
    set_atten_lim(lim_db) {
        wasm.deepfilter_set_atten_lim(this.__wbg_ptr, lim_db);
    }
    /**
     * Post filter strength; 0 disables it, 0.02 is the upstream default when on.
     * @param {number} beta
     */
    set_post_filter_beta(beta) {
        wasm.deepfilter_set_post_filter_beta(this.__wbg_ptr, beta);
    }
    /**
     * Changes the stage thresholds (see `new`).
     * @param {number} min_db_thresh
     * @param {number} max_db_erb_thresh
     * @param {number} max_db_df_thresh
     */
    set_thresholds(min_db_thresh, max_db_erb_thresh, max_db_df_thresh) {
        wasm.deepfilter_set_thresholds(this.__wbg_ptr, min_db_thresh, max_db_erb_thresh, max_db_df_thresh);
    }
}
if (Symbol.dispose) DeepFilter.prototype[Symbol.dispose] = DeepFilter.prototype.free;
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_960c155d3d49e4c2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_6b64449b9b9ed33c: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_getRandomValues_cc7f052a444bb2ce: function() { return handleError(function (arg0, arg1) {
            globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1));
        }, arguments); },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./df_bg.js": import0,
    };
}

const DeepFilterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_deepfilter_free(ptr >>> 0, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc_command_export();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store_command_export(idx);
    }
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc_command_export(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('df_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
