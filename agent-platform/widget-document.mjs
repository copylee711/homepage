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
  // Follow the host theme (passed as ?theme=dark|light and live postMessage),
  // auto-adapt legacy/hardcoded light colors in dark mode, and report rendered
  // height so the parent container fits seamlessly without inner scrollbars.
  const theme = '<script>(function(){' +
    'var m=/[?&]theme=(dark|light)/.exec(location.search),' +
    't=m?m[1]:(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");' +
    'document.documentElement.dataset.theme=t;' +
    'document.documentElement.style.colorScheme=t;' +
  '})();<\/script>';
  const sizing = '<script>(function(){' +
    'var last=0,count=0;' +
    'function parseRgb(s){' +
      'if(!s)return null;' +
      'var m=/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:[,/\\s]+([\\d.]+))?/.exec(s);' +
      'if(m)return{r:+m[1],g:+m[2],b:+m[3],a:m[4]!==undefined?+m[4]:1};' +
      'var h=/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());' +
      'if(!h)return null;var x=h[1];' +
      'if(x.length===3)x=x[0]+x[0]+x[1]+x[1]+x[2]+x[2];' +
      'var n=parseInt(x,16);return{r:(n>>16)&255,g:(n>>8)&255,b:n&255,a:1};' +
    '}' +
    'function lum(c){return(0.2126*c.r+0.7152*c.g+0.0722*c.b)/255;}' +
    'function sat(c){var mx=Math.max(c.r,c.g,c.b),mn=Math.min(c.r,c.g,c.b);return mx===0?0:(mx-mn)/mx;}' +
    'function adaptDark(){' +
      'var isDark=document.documentElement.dataset.theme==="dark";' +
      'var nodes=document.body?document.body.querySelectorAll("*"):[];' +
      'for(var i=0;i<nodes.length;i++){' +
        'var el=nodes[i];if(el.tagName==="SCRIPT"||el.tagName==="STYLE")continue;' +
        'if(!isDark){' +
          'if(el.dataset.irisOrigColor!==undefined){el.style.color=el.dataset.irisOrigColor;delete el.dataset.irisOrigColor;}' +
          'if(el.dataset.irisOrigBg!==undefined){el.style.backgroundColor=el.dataset.irisOrigBg;delete el.dataset.irisOrigBg;}' +
          'if(el.dataset.irisOrigBorder!==undefined){el.style.borderColor=el.dataset.irisOrigBorder;delete el.dataset.irisOrigBorder;}' +
          'if(el.dataset.irisOrigFill!==undefined){if(el.dataset.irisOrigFill)el.setAttribute("fill",el.dataset.irisOrigFill);else el.removeAttribute("fill");delete el.dataset.irisOrigFill;}' +
          'if(el.dataset.irisOrigStroke!==undefined){if(el.dataset.irisOrigStroke)el.setAttribute("stroke",el.dataset.irisOrigStroke);else el.removeAttribute("stroke");delete el.dataset.irisOrigStroke;}' +
          'continue;' +
        '}' +
        'var cs=getComputedStyle(el);' +
        'var bg=parseRgb(cs.backgroundColor);' +
        'if(bg&&bg.a>0.55&&lum(bg)>0.80){' +
          'if(el.dataset.irisOrigBg===undefined)el.dataset.irisOrigBg=el.style.backgroundColor||"";' +
          'el.style.backgroundColor=sat(bg)>0.18?"rgba("+bg.r+","+bg.g+","+bg.b+",0.14)":"rgba(255,255,255,0.045)";' +
        '}' +
        'var bc=parseRgb(cs.borderTopColor);' +
        'if(bc&&bc.a>0.4&&lum(bc)>0.75&&sat(bc)<0.2){' +
          'if(el.dataset.irisOrigBorder===undefined)el.dataset.irisOrigBorder=el.style.borderColor||"";' +
          'el.style.borderColor="rgba(255,255,255,0.12)";' +
        '}' +
        'var fg=parseRgb(cs.color);' +
        'if(fg&&fg.a>0.5&&lum(fg)<0.42&&sat(fg)<0.35){' +
          'if(el.dataset.irisOrigColor===undefined)el.dataset.irisOrigColor=el.style.color||"";' +
          'el.style.color=lum(fg)<0.22?"#ececf1":"#b4b4be";' +
        '}' +
        'if(el instanceof SVGElement){' +
          'var fAttr=el.getAttribute("fill")||cs.fill;' +
          'var fc=parseRgb(fAttr);' +
          'if(fc&&fc.a>0.5){' +
            'var tag=el.tagName.toLowerCase();' +
            'if((tag==="text"||tag==="tspan")&&lum(fc)<0.45&&sat(fc)<0.35){' +
              'if(el.dataset.irisOrigFill===undefined)el.dataset.irisOrigFill=el.getAttribute("fill")||"";' +
              'el.setAttribute("fill",lum(fc)<0.22?"#ececf1":"#b4b4be");' +
            '}else if((tag==="rect"||tag==="circle"||tag==="ellipse"||tag==="path"||tag==="polygon")&&lum(fc)>0.84&&sat(fc)<0.2){' +
              'if(el.dataset.irisOrigFill===undefined)el.dataset.irisOrigFill=el.getAttribute("fill")||"";' +
              'el.setAttribute("fill","rgba(255,255,255,0.05)");' +
            '}' +
          '}' +
          'var sAttr=el.getAttribute("stroke")||cs.stroke;' +
          'var sc=parseRgb(sAttr);' +
          'if(sc&&sc.a>0.5&&lum(sc)<0.32&&sat(sc)<0.3){' +
            'if(el.dataset.irisOrigStroke===undefined)el.dataset.irisOrigStroke=el.getAttribute("stroke")||"";' +
            'el.setAttribute("stroke","#d4d4dc");' +
          '}' +
        '}' +
      '}' +
    '}' +
    'function measure(){' +
      'var b=document.body;if(!b)return 0;' +
      'var ch=b.children,maxB=0;' +
      'for(var i=0;i<ch.length;i++){' +
        'var el=ch[i];if(el.tagName==="SCRIPT"||el.tagName==="STYLE")continue;' +
        'var r=el.getBoundingClientRect();' +
        'var top=el.offsetTop||0,h=el.offsetHeight||r.height||0;' +
        'if(top+h>maxB)maxB=top+h;' +
      '}' +
      'var pad=0;try{pad=parseFloat(getComputedStyle(b).paddingBottom)||8}catch(e){pad=8}' +
      'return Math.ceil(maxB>0?(maxB+pad):b.scrollHeight);' +
    '}' +
    'function send(){' +
      'var h=measure();if(!h||Math.abs(h-last)<=2)return;' +
      'if(count>8&&h>last)return;' +
      'last=h;count++;' +
      'try{parent.postMessage({type:"iris-widget-height",height:h},"*")}catch(e){}' +
    '}' +
    'addEventListener("message",function(e){' +
      'if(e.data&&e.data.type==="iris-theme"){' +
        'var nt=e.data.theme==="dark"?"dark":"light";' +
        'document.documentElement.dataset.theme=nt;' +
        'document.documentElement.style.colorScheme=nt;' +
        'adaptDark();send();' +
      '}' +
    '});' +
    'addEventListener("load",function(){adaptDark();send();});' +
    'if(window.ResizeObserver&&document.body){' +
      'new ResizeObserver(function(){send()}).observe(document.body);' +
    '}' +
    '[30,120,350,800].forEach(function(ms){setTimeout(function(){adaptDark();send();},ms)});' +
  '})();<\/script>';
  const style = 'html,body{height:auto!important;min-height:0!important;overflow:hidden!important;scrollbar-width:none!important;-ms-overflow-style:none!important}' +
    'html::-webkit-scrollbar,body::-webkit-scrollbar{display:none!important;width:0!important;height:0!important}' +
    'html{' +
      '--widget-bg:transparent;--widget-surface:#f8f8f7;--widget-card:#ffffff;--widget-fg:#1d1d1f;--widget-muted:#6b6b73;--widget-line:rgba(20,20,26,.11);--widget-accent:#2563eb;' +
      '--bg:transparent;--surface:#f8f8f7;--surface-2:#f1f1ef;--card:#ffffff;--text:#1d1d1f;--text-2:#3f3f46;--fg:#1d1d1f;--muted:#6b6b73;--border:rgba(20,20,26,.11);--line:rgba(20,20,26,.11);--accent:#2563eb;' +
      'font:14.5px/1.6 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--widget-fg);background:transparent' +
    '}' +
    'html[data-theme=dark]{' +
      '--widget-bg:transparent;--widget-surface:#1c1c1f;--widget-card:#18181b;--widget-fg:#ececf1;--widget-muted:#9a9aa3;--widget-line:rgba(255,255,255,.12);--widget-accent:#60a5fa;' +
      '--bg:transparent;--surface:#1c1c1f;--surface-2:#242428;--card:#18181b;--text:#ececf1;--text-2:#d4d4d8;--fg:#ececf1;--muted:#9a9aa3;--border:rgba(255,255,255,.12);--line:rgba(255,255,255,.12);--accent:#60a5fa;' +
      'color:var(--widget-fg);background:transparent' +
    '}' +
    'body{margin:0;padding:6px 2px;box-sizing:border-box;background:transparent;color:var(--widget-fg)}*,*::before,*::after{box-sizing:border-box}svg,canvas,img{max-width:100%;height:auto}button,input,select{font:inherit;color:inherit}input[type=range]{width:100%;accent-color:var(--widget-accent)}button{cursor:pointer}h1,h2,h3,h4{line-height:1.3;color:var(--widget-fg)}pre{white-space:pre-wrap}' +
    '@media(max-width:560px){body{padding:4px 0}}';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'+style+'</style>'+theme+'</head><body>'+unwrapDocument(html)+sizing+'</body></html>';
}
export const WIDGET_CSP="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
