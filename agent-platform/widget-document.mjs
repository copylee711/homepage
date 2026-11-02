export function widgetDocument(html) {
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{font:15px/1.6 system-ui,sans-serif;color:#222;background:#fff}body{margin:0;padding:18px;box-sizing:border-box}*,*::before,*::after{box-sizing:border-box}svg,canvas,img{max-width:100%}button,input,select{font:inherit}input[type=range]{width:100%;accent-color:#555}button{cursor:pointer}h1,h2,h3{line-height:1.3}pre{white-space:pre-wrap}</style></head><body>'+html+'</body></html>';
}
export const WIDGET_CSP="sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
