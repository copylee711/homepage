// Models often hand back a full HTML document (<!doctype html><html><head>…<body>…).
// The wrapper below already supplies those shells, and a second </body></html>
// makes the parser drop or misplace the sizing script that follows. Unwrap the
// document-level tags and keep the model's own style/script/content.
function unwrapDocument(html) {
  return String(html || '')
    .replace(/<!doctype[^>]*>/gi, '')
    .replace(/<\/?html\b[^>]*>/gi, '')
    .replace(/<\/?head\b[^>]*>/gi, '')
    .replace(/<\/?body\b[^>]*>/gi, '');
}

export function widgetDocument(html) {
  // Follow the host theme (passed as ?theme=dark|light), report the rendered
  // height so the parent card can grow to fit instead of showing an inner
  // scroll area.
  const theme = '<script>(function(){var m=/[?&]theme=(dark|light)/.exec(location.search),t=m?m[1]:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t;document.documentElement.style.colorScheme=t})();<\/script>';
  const sizing = '<script>(function(){' +
    'var last=0,count=0;' +
    'function measure(){' +
      'var b=document.body;if(!b)return 0;' +
      'var ch=b.children,maxB=0;' +
      'for(var i=0;i<ch.length;i++){' +
        'var el=ch[i];if(el.tagName==="SCRIPT")continue;' +
        'var r=el.getBoundingClientRect();' +
        'var top=el.offsetTop||0,h=el.offsetHeight||r.height||0;' +
        'if(top+h>maxB)maxB=top+h;' +
      '}' +
      'var pad=0;try{pad=parseFloat(getComputedStyle(b).paddingBottom)||16}catch(e){pad=16}' +
      'return Math.ceil(maxB>0?(maxB+pad):b.scrollHeight);' +
    '}' +
    'function send(){' +
      'var h=measure();if(!h||Math.abs(h-last)<=2)return;' +
      'if(count>6&&h>last)return;' +
      'last=h;count++;' +
      'try{parent.postMessage({type:"iris-widget-height",height:h},"*")}catch(e){}' +
    '}' +
    'addEventListener("load",send);' +
    'if(window.ResizeObserver&&document.body){' +
      'new ResizeObserver(function(){send()}).observe(document.body);' +
    '}' +
    '[60,300,800].forEach(function(ms){setTimeout(send,ms)});' +
  '})();<\/script>';
  const style = 'html,body{height:auto!important;min-height:0!important;overflow:hidden!important;scrollbar-width:none!important;-ms-overflow-style:none!important}' +
    'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
    'html{--widget-bg:#fff;--widget-fg:#222;--widget-muted:#6b6b73;--widget-line:rgba(20,20,26,.12);font:15px/1.6 system-ui,sans-serif;color:var(--widget-fg);background:var(--widget-bg)}' +
    'html[data-theme=dark]{--widget-bg:#141416;--widget-fg:#ecedef;--widget-muted:#9a9aa3;--widget-line:rgba(255,255,255,.13)}' +
    'body{margin:0;padding:16px;box-sizing:border-box;background:var(--widget-bg)}*,*::before,*::after{box-sizing:border-box}svg,canvas,img{max-width:100%;height:auto}button,input,select{font:inherit}input[type=range]{width:100%;accent-color:#555}button{cursor:pointer}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap}' +
    '@media(max-width:560px){body{padding:10px 8px}}';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+style+'</style>'+theme+'</head><body>'+unwrapDocument(html)+sizing+'</body></html>';
}
export const WIDGET_CSP="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
