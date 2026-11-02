export function widgetDocument(html) {
  // Follow the host theme (passed as ?theme=dark|light), report the rendered
  // height so the parent card can grow to fit instead of showing an inner
  // scroll area.
  const theme = '<script>(function(){var m=/[?&]theme=(dark|light)/.exec(location.search),t=m?m[1]:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t})();<\/script>';
  const sizing = '<script>(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.scrollHeight);if(!h||h===last)return;last=h;try{parent.postMessage({type:"iris-widget-height",height:h},"*")}catch(e){}}addEventListener("load",send);if(window.ResizeObserver)new ResizeObserver(send).observe(document.body);setTimeout(send,60);setTimeout(send,400)})();<\/script>';
  const style = 'html{--widget-bg:#fff;--widget-fg:#222;--widget-muted:#6b6b73;--widget-line:rgba(20,20,26,.12);font:15px/1.6 system-ui,sans-serif;color:var(--widget-fg);background:var(--widget-bg)}' +
    'html[data-theme=dark]{--widget-bg:#141416;--widget-fg:#ecedef;--widget-muted:#9a9aa3;--widget-line:rgba(255,255,255,.13)}' +
    'body{margin:0;padding:18px;box-sizing:border-box;background:var(--widget-bg)}*,*::before,*::after{box-sizing:border-box}svg,canvas,img{max-width:100%}button,input,select{font:inherit}input[type=range]{width:100%;accent-color:#555}button{cursor:pointer}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap}';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+style+'</style>'+theme+'</head><body>'+html+sizing+'</body></html>';
}
export const WIDGET_CSP="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
