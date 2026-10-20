(() => {
  let versions = JSON.parse(document.getElementById('content-versions').textContent);
  let failures = 0, timer;
  const json = async path => {
    const response = await fetch(path, { cache:'no-store', signal:AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('内容暂时不可用');
    return response.json();
  };
  const updateList = items => {
    const list = document.getElementById('post-list');
    if (!list) return;
    const fragment = document.createDocumentFragment();
    for (const post of items) {
      const link = document.createElement('a'); link.className = 'post-item'; link.href = '/posts/' + post.slug;
      const date = document.createElement('time'); date.textContent = post.published_at.slice(0,10);
      const copy = document.createElement('div'), title = document.createElement('h2'), summary = document.createElement('p');
      title.textContent = post.title; summary.textContent = post.summary; copy.append(title,summary);
      const arrow = document.createElement('span'); arrow.textContent='↗'; arrow.setAttribute('aria-hidden','true');
      link.append(date,copy,arrow); fragment.append(link);
    }
    if (!items.length) { const empty=document.createElement('div'); empty.className='empty-posts'; const label=document.createElement('span'), title=document.createElement('h2'), text=document.createElement('p'), link=document.createElement('a'); label.className='label'; label.textContent='Coming soon'; title.textContent='一些想法，正在成形。'; text.textContent='暂时还没有发布文章。'; link.href='/#projects'; link.textContent='先看看我的项目 ↗'; empty.append(label,title,text,link); fragment.append(empty); }
    list.replaceChildren(fragment);
    document.querySelector('.article-total').textContent=String(items.length);
  };
  async function check() {
    clearTimeout(timer);
    if (document.hidden) return;
    try {
      const next = await json('/api/version');
      if (next.site !== versions.site) {
        const {site} = await json('/api/site');
        document.querySelectorAll('[data-site-name]').forEach(el => el.textContent=site.name);
        document.querySelectorAll('[data-cloud]').forEach(el => el.href=site.cloud);
        document.querySelectorAll('[data-github]').forEach(el => el.href='https://github.com/'+site.github);
        const beian = document.querySelector('[data-beian]');
        if (beian) {
          const links = [];
          if (site.icp) { const a=document.createElement('a'); a.href='https://beian.miit.gov.cn/'; a.textContent=site.icp; links.push(a); }
          if (site.police?.text) { const a=document.createElement('a'); a.href='https://beian.mps.gov.cn/#/query/webSearch?code='+encodeURIComponent(site.police.code); a.textContent=site.police.text; links.push(a); }
          for (const a of links) { a.target='_blank'; a.rel='noopener'; }
          beian.replaceChildren(...links);
        }
      }
      if (next.posts !== versions.posts) {
        const {items} = await json('/api/posts'); updateList(items);
        const slug = document.body.dataset.slug;
        if (slug) {
          const post = items.find(item => item.slug===slug);
          if (!post) {
            const content=document.getElementById('article-content');
            content.replaceChildren(); const message=document.createElement('p'); message.textContent='这篇文章已撤下。'; content.append(message);
            document.getElementById('article-update').hidden=true;
            document.body.dataset.slug='';
          } else if (post.public_revision !== Number(document.body.dataset.postRevision)) document.getElementById('article-update').hidden=false;
        }
      }
      versions=next; failures=0;
    } catch { failures=Math.min(failures+1,4); }
    timer=setTimeout(check,30000 * 2 ** failures);
  }
  document.addEventListener('visibilitychange', () => { if(document.hidden) clearTimeout(timer); else check(); });
  timer=setTimeout(check,30000);
})();
