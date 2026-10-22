/**
 * The hall's stylesheet, scoped to `.gh` and injected into the stage at mount (removed on unmount).
 * Portrait phone first; container queries switch to the landscape phone layout (reels left, SPIN
 * under the right thumb, friends as a column at the far left) and the desktop layout (reels up to
 * 720 px, a hall sidebar). Every animation here is finite.
 */
export const CSS = `
.gh{--acc:#4fd0c8;--gold:#f0c030;position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:0;overflow:hidden;color:var(--color-text,#dbdee1);background:#141519;container-type:size;font:13px/1.3 system-ui,-apple-system,"Segoe UI",sans-serif;user-select:none;-webkit-user-select:none;outline:none}
.gh[data-m="0"]{--acc:#e8a23a}.gh[data-m="1"]{--acc:#4fd0c8}.gh[data-m="2"]{--acc:#ff8a3a}
.gh :where(button){touch-action:manipulation;font:inherit;color:inherit;background:none;border:0;padding:0;cursor:pointer;-webkit-tap-highlight-color:transparent}
.gh button:disabled{opacity:.45;cursor:default}
.gh button:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.gh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.gh-top{display:flex;align-items:center;gap:6px;padding:6px 8px;flex:none;contain:layout style}
.gh-bal{display:flex;align-items:center;gap:6px;height:36px;padding:0 10px 0 8px;border-radius:18px;background:var(--color-elevated,#383a40);font-weight:700;color:var(--color-text-bright,#f2f3f5);white-space:nowrap;min-width:0}
.gh-bal img,.gh-mem img,.gh-emo img{image-rendering:pixelated}
.gh-bal img{width:18px;height:18px}
.gh-net{font-size:11px;font-weight:600;color:var(--color-text-muted,#949ba4)}
.gh-net.up{color:#5fd38a}
.gh-badge{font-size:10px;font-weight:800;letter-spacing:.05em;padding:1px 5px;border-radius:3px;background:#1f8a85;color:#fff}
.gh-sp{flex:1}
.gh-pill{height:36px;padding:0 12px;border-radius:18px;background:var(--color-elevated,#383a40);font-weight:700;white-space:nowrap}
.gh-pill.on{background:var(--acc);color:#141519}
.gh-round{width:36px;height:36px;border-radius:18px;background:var(--color-elevated,#383a40);font-weight:800}
.gh-tabs{display:flex;gap:4px;padding:0 8px 6px;flex:none}
.gh-tab{flex:1;min-width:0;height:34px;border-radius:8px;background:var(--color-sidebar,#2b2d31);color:var(--color-text-muted,#949ba4);font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-tab[aria-selected="true"]{background:var(--acc);color:#141519}
.gh-body{display:flex;flex-direction:column;flex:1;min-height:0}
.gh-play{position:relative;display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
.gh-reelbox{position:relative;flex:1;min-height:120px;margin:0 8px}
.gh-reels{position:absolute;inset:0;display:flex}
.gh-hits{position:absolute;inset:0;display:flex;gap:4px;padding:6% 4%}
.gh-hits button{flex:1}
.gh-banner{position:absolute;left:8px;right:8px;top:4px;z-index:3;padding:8px 12px;border-radius:10px;background:rgba(20,16,24,.92);border:1px solid var(--acc);color:#fff;font-weight:700;text-align:center;pointer-events:none;animation:gh-banner 4.2s ease forwards}
@keyframes gh-banner{0%{opacity:0;transform:translateY(-6px)}8%,85%{opacity:1;transform:none}100%{opacity:0}}
.gh-meter{flex:none;display:flex;flex-direction:column;align-items:center;justify-content:center;height:48px;padding:2px 8px;contain:strict;overflow:hidden}
.gh-win{font-size:20px;font-weight:800;color:var(--color-text-bright,#f2f3f5);font-variant-numeric:tabular-nums;text-align:center}
.gh-win.small{color:var(--color-text-muted,#949ba4);font-size:16px;font-weight:600}
.gh-win.idle{color:var(--color-text-faint,#6d6f78);font-size:15px;font-weight:600}
.gh-sub{font-size:12px;color:var(--color-text-muted,#949ba4);min-height:15px;text-align:center}
.gh-friends{flex:none;display:flex;gap:6px;overflow-x:auto;padding:4px 8px;scrollbar-width:none;contain:layout style}
.gh-friends.shut .gh-mem:not(.me){display:none}
.gh-mem{position:relative;flex:none;display:flex;align-items:center;gap:6px;height:44px;padding:0 10px 0 4px;border-radius:22px;background:var(--color-sidebar,#2b2d31);text-align:left;max-width:170px}
.gh-mem.away{opacity:.45}
.gh-av{flex:none;width:32px;height:32px;border-radius:16px;display:flex;align-items:center;justify-content:center;font-weight:800;color:#141519;font-size:14px}
.gh-mt{display:flex;flex-direction:column;min-width:0}
.gh-mn{font-weight:700;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--color-text-bright,#f2f3f5)}
.gh-mw{font-size:11px;color:var(--color-text-muted,#949ba4);white-space:nowrap}
.gh-mem img{width:16px;height:16px;flex:none}
.gh-bub{position:absolute;left:12px;top:-14px;width:24px;height:24px;pointer-events:none;animation:gh-bub 1.8s ease-out forwards}
@keyframes gh-bub{0%{opacity:0;transform:translateY(6px) scale(.6)}15%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0;transform:translateY(-10px)}}
.gh-fold{flex:none;height:44px;width:44px;border-radius:22px;background:var(--color-sidebar,#2b2d31);font-weight:800}
.gh-ctrl{flex:none;display:flex;align-items:center;justify-content:center;gap:8px;padding:6px 8px 4px}
.gh-sq{width:48px;height:48px;border-radius:12px;background:var(--color-elevated,#383a40);font-size:22px;font-weight:800;flex:none}
.gh-bet{display:flex;flex-direction:column;align-items:center;width:58px;flex:none}
.gh-bet b{font-size:17px;color:var(--color-text-bright,#f2f3f5);font-variant-numeric:tabular-nums}
.gh-bet span{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--color-text-muted,#949ba4)}
.gh-spin{width:76px;height:76px;border-radius:38px;flex:none;background:radial-gradient(circle at 35% 30%,#fff6 0,#0000 45%),var(--acc);color:#141519!important;font-weight:900;font-size:15px;letter-spacing:.04em;box-shadow:0 3px 0 #0006}
.gh-spin:active{transform:translateY(2px);box-shadow:0 1px 0 #0006}
.gh-spin.busy{filter:saturate(.6) brightness(.9)}
.gh-auto{width:56px;height:48px;border-radius:12px;background:var(--color-elevated,#383a40);font-weight:800;font-size:12px;flex:none}
.gh-auto.on{background:#f0b232;color:#141519}
.gh-foot{flex:none;padding:2px 10px 6px;font-size:10.5px;line-height:1.3;text-align:center;color:var(--color-text-faint,#6d6f78)}
.gh-side{display:contents}
.gh-pot{display:none}
.gh-pot.on{display:flex;align-items:center;justify-content:center;gap:6px;flex:none;margin:0 8px 2px;height:28px;border-radius:14px;background:linear-gradient(90deg,#3a2a08,#6a4a10,#3a2a08);color:#ffe08a;font-weight:800;font-size:12px}
.gh-sheet{position:absolute;inset:0;z-index:10;display:flex;align-items:center;justify-content:center;padding:12px;background:rgba(0,0,0,.62)}
.gh-card{position:relative;width:100%;max-width:440px;max-height:100%;overflow:auto;border-radius:14px;background:var(--color-main,#313338);padding:16px;box-shadow:0 10px 30px #0008;user-select:text;-webkit-user-select:text}
.gh-card h3{margin:0 0 8px;font-size:16px;color:var(--color-text-bright,#f2f3f5)}
.gh-card h4{margin:14px 0 6px;font-size:13px;color:var(--color-text-bright,#f2f3f5)}
.gh-card p{margin:0 0 8px;color:var(--color-text,#dbdee1)}
.gh-card .muted{color:var(--color-text-muted,#949ba4);font-size:12px}
.gh-x{position:absolute;right:8px;top:8px;width:40px;height:40px;border-radius:20px;font-size:20px;font-weight:700;color:var(--color-text-muted,#949ba4)}
.gh-row{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.gh-opt{min-width:56px;height:40px;padding:0 12px;border-radius:10px;background:var(--color-elevated,#383a40);font-weight:700}
.gh-opt[aria-pressed="true"]{background:var(--acc);color:#141519}
.gh-go{display:block;width:100%;height:46px;margin-top:12px;border-radius:12px;background:var(--acc);color:#141519!important;font-weight:800;font-size:15px}
.gh-go.alt{background:var(--color-elevated,#383a40);color:var(--color-text-bright,#f2f3f5)!important}
.gh-tbl{width:100%;border-collapse:collapse;font-size:12px}
.gh-tbl td,.gh-tbl th{padding:3px 4px;text-align:right;font-variant-numeric:tabular-nums}
.gh-tbl th{color:var(--color-text-muted,#949ba4);font-weight:600}
.gh-tbl td:first-child,.gh-tbl th:first-child{text-align:left}
.gh-tbl img{width:24px;height:24px;vertical-align:middle;image-rendering:pixelated;margin-right:6px}
.gh-lines{display:flex;flex-wrap:wrap;gap:6px}
.gh-lines svg{background:#0003;border-radius:4px}
.gh-emo{display:flex;gap:4px;flex-wrap:wrap}
.gh-emo button{width:48px;height:48px;border-radius:12px;background:var(--color-elevated,#383a40)}
.gh-emo img{width:30px;height:30px}
.gh-score{width:100%;font-size:13px}
.gh-score td{padding:4px}
.gh-score .me td{color:var(--acc);font-weight:800}
.gh-paused{position:absolute;inset:0;z-index:12;display:flex;align-items:center;justify-content:center;background:rgba(10,10,14,.72);color:#fff;font-weight:800;font-size:16px}
@container (orientation:landscape) and (max-height:520px){
.gh-top{padding:4px 8px}
.gh-tabs{padding:0 8px 4px}
.gh-tab{height:28px}
.gh-body{flex-direction:row}
.gh-play{display:grid;grid-template-columns:1fr auto;grid-template-rows:minmax(0,1fr) auto;column-gap:4px}
.gh-reelbox{grid-column:1;grid-row:1;margin:0 0 0 4px}
.gh-meter{grid-column:1;grid-row:2;height:40px}
.gh-ctrl{grid-column:2;grid-row:1 / span 2;display:grid;grid-template-columns:48px 44px 48px;gap:6px;align-content:center;justify-items:center;padding:2px 8px;min-height:0}
.gh-ctrl .gh-bet{width:44px}
.gh-ctrl .gh-spin{grid-column:1 / span 3;grid-row:2}
.gh-ctrl .gh-auto{grid-column:1 / span 3;grid-row:3;width:100%;height:36px}
.gh-banner{right:170px}
.gh-side{display:flex;flex-direction:column;order:-1;width:54px;flex:none;min-height:0}
.gh-friends{flex-direction:column;overflow-y:auto;overflow-x:hidden;padding:4px;flex:1;min-height:0}
.gh-mem{width:44px;height:44px;padding:0;justify-content:center;border-radius:22px}
.gh-mem .gh-mt,.gh-mem img{display:none}
.gh-fold{display:none}
.gh-friends.shut .gh-mem:not(.me){display:flex}
.gh-foot{padding:0 8px 2px;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-pot.on{margin:2px 4px;height:24px;font-size:10px;flex-direction:column;border-radius:8px;height:auto;padding:2px}
}
@container (min-width:900px) and (min-height:521px){
.gh-top,.gh-tabs{padding-left:16px;padding-right:16px}
.gh-tabs{max-width:752px;width:100%;margin:0 auto}
.gh-body{flex-direction:row}
.gh-reelbox{margin:0 16px;max-width:720px;width:calc(100% - 32px);align-self:center}
.gh-side{display:flex;flex-direction:column;width:270px;flex:none;border-left:1px solid var(--color-border,#ffffff10);padding:8px 0;min-height:0}
.gh-pot.on{height:40px;font-size:14px;margin:0 12px 8px}
.gh-friends{flex-direction:column;overflow-y:auto;overflow-x:hidden;padding:0 12px;flex:1}
.gh-mem{max-width:none;width:100%}
.gh-fold{display:none}
.gh-friends.shut .gh-mem:not(.me){display:flex}
}
@media (prefers-reduced-motion:reduce){.gh-banner,.gh-bub{animation-duration:.01s;animation-delay:2s}}
`;
