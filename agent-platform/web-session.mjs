export class WebSession {
  constructor(){this.cache=new Map();this.used={search:0,fetch:0,image:0};this.failures={search:0,fetch:0,image:0};}
  async run(kind,key,operation){
    const cacheKey=kind+':'+key.trim().replace(/\s+/g,' ');if(this.cache.has(cacheKey))return this.cache.get(cacheKey);
    const limit = { search: 6, fetch: 8, image: 2 }[kind];
    if(this.used[kind]>=limit||this.failures[kind]>=3)return {status:'unavailable',results:[],images:[],stopRetry:true,notice:'本轮检索已达到重试或请求预算。停止换词重试，基于已核实来源回答并明确尚未核实的部分；用户继续追问后会开启新预算。'};
    this.used[kind]++;
    const task=(async()=>{try{const result=await operation();this.failures[kind]=0;return result;}catch{return {status:'unavailable',results:[],images:[],stopRetry:++this.failures[kind]>=3,notice:'来源连接失败或没有相关结果。本轮已失败 '+this.failures[kind]+' 次；优先换一个可靠来源，连续三次失败后停止检索并说明限制。'};}})();
    this.cache.set(cacheKey,task);return task;
  }
}
