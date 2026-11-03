import { fail } from './shared.mjs';
export function promptInput(input) {
  if(typeof input.message!=='string'||input.message.length>20000)fail(422,'任务文字最多 20000 个字符');
  const images=Array.isArray(input.images)?input.images.filter(img=>img&&typeof img.data==='string'&&img.data.length>0&&img.data.length<=12*1024*1024&&['image/png','image/jpeg','image/gif','image/webp','image/bmp'].includes(img.mimeType)).map(img=>({type:'image',data:img.data,mimeType:img.mimeType})):[];
  if(images.length>8)fail(422,'单条消息最多 8 张图片');
  if(!input.message.trim()&&!images.length)fail(422,'请发送文字或图片');
  return {message:input.message,images:images.length?images:undefined};
}
