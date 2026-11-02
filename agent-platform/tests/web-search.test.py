import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('search',Path(__file__).parents[1]/'web-search.py');search=importlib.util.module_from_spec(spec);spec.loader.exec_module(search)
class SearchTests(unittest.TestCase):
    def test_baidu_title_url_snippet(self):
        html='<div mu="https://docs.python.org/"><h3><a href="http://www.baidu.com/link?url=a">Python <em>Docs</em></a></h3><p>Official documentation</p></div>'
        result=search.search_public({'query':'Python','engine':'auto','count':3},lambda url,**kwargs:{'status':200,'text':html})
        self.assertEqual(result['engine'],'baidu');self.assertEqual(result['results'][0]['url'],'https://docs.python.org/');self.assertEqual(result['results'][0]['title'],'Python Docs')
    def test_fallback_and_dedup(self):
        def fetch(url,**kwargs):
            if 'baidu' in url:return {'status':200,'text':'captcha'}
            return {'status':200,'text':'<rss><channel><item><title>Docs</title><link>https://python.org</link><description>Real</description></item><item><title>Duplicate</title><link>https://python.org</link></item></channel></rss>'}
        result=search.search_public({'query':'Python'},fetch);self.assertEqual(result['engine'],'bing');self.assertEqual(len(result['results']),1)
    def test_invalid_query_and_provider(self):
        for value in [{'query':''},{'query':'x','engine':'http://localhost'},{'query':'x','count':True}]:
            with self.assertRaises(ValueError):search.search_public(value,lambda *_:None)
    def test_custom_json_mapping_auth_template_and_redaction(self):
        source={'id':'deepseek','name':'DeepSeek','kind':'json','enabled':True,'endpoint':'https://api.deepseek.com/v1/tools/search','auth':'bearer','apiKey':'private-key','bodyTemplate':{'query':'{{query}}','count':'{{count}}'},'mapping':{'results':'data.results','title':'title','url':'url','snippet':'summary'}}
        def fetch(url,**kwargs):
            import json
            self.assertEqual(kwargs['request']['headers']['Authorization'],'Bearer private-key')
            self.assertEqual(json.loads(kwargs['request']['body']),{'query':'Python','count':3})
            return {'status':200,'text':json.dumps({'data':{'results':[{'title':'Docs','url':'https://docs.python.org','summary':'never expose private-key'}]}})}
        result=search.search_public({'query':'Python','count':3,'sources':[source]},fetch)
        self.assertEqual(result['results'][0]['snippet'],'never expose [REDACTED]')
    def test_catalog_adapters_and_image_sources(self):
        import json
        presets=json.loads((Path(__file__).parents[1]/'search-presets.json').read_text(encoding='utf8'))
        self.assertGreaterEqual(len(presets),35)
        self.assertEqual(len([p for p in presets if p['category']=='image']),6)
        for source in presets:
            if source['kind']!='json': continue
            source={**source,'enabled':True,'apiKey':'synthetic-secret'}
            fmt=source.get('format')
            image={'url':'https://images.example.com/a.jpg','title':'A','license':'CC BY','thumbnail':'https://images.example.com/t.jpg','foreign_landing_url':'https://example.com/page','creator':'Alice'}
            if fmt=='wikimedia': data={'query':{'pages':{'1':{'title':'A','imageinfo':[{'url':image['url'],'thumburl':image['thumbnail'],'descriptionurl':image['foreign_landing_url'],'extmetadata':{'Artist':{'value':'Alice'},'LicenseShortName':{'value':'CC BY'}}}]}}}}
            elif fmt=='openverse':data={'results':[image]}
            elif fmt=='pexels':data={'photos':[{'src':{'original':image['url'],'medium':image['thumbnail']},'photographer':'Alice','url':'https://example.com'}]}
            elif fmt=='unsplash':data={'results':[{'urls':{'regular':image['url']},'links':{'html':'https://example.com'},'user':{'name':'Alice'}}]}
            elif fmt=='pixabay':data={'hits':[{'largeImageURL':image['url'],'user':'Alice'}]}
            elif fmt=='auto':data={'result':{'content':[{'type':'text','text':'[Source](https://example.com/result)'}]}}
            else:
                mapping=source['mapping'];item={}
                def put(obj,path,value):
                    keys=path.split('.')
                    for k in keys[:-1]:obj=obj.setdefault(k,{})
                    obj[keys[-1]]=value
                put(item,mapping['url'],'https://example.com/result');put(item,mapping['title'],'A');put(item,mapping['snippet'],'snippet')
                data={};put(data,mapping['results'],[item])
            captured=[]
            def fetch(url,**kwargs):captured.append((url,kwargs));return {'status':200,'text':json.dumps(data)}
            result=search.json_search(source,'test query',3,'en-US',fetch)
            self.assertGreater(len(result['results']),0,source['id'])
            self.assertEqual(captured[0][1]['request']['method'],source['method'])
            if source['auth']=='x-api-key':self.assertEqual(captured[0][1]['request']['headers']['X-API-Key'],'synthetic-secret')
        self.assertEqual(search.auto_results({'citations':['https://example.com']} )[0]['url'],'https://example.com')
    def test_image_category_cannot_use_web_sources(self):
        calls=[]
        with self.assertRaises(ValueError):search.search_public({'query':'cats','category':'image','sources':[{'id':'baidu','kind':'baidu','enabled':True}]},lambda url,**kw:calls.append(url))
        self.assertEqual(calls,[])
    def test_page_images_and_svg_are_safe(self):
        spec=importlib.util.spec_from_file_location('access',Path(__file__).parents[1]/'web-access.py');access=importlib.util.module_from_spec(spec);spec.loader.exec_module(access)
        parser=access.TextHTML('https://mathworld.wolfram.com/Ellipse.html');parser.feed('<img src="/logo.png"><img src="/images/ellipse.svg" alt="Ellipse reflection geometry"><p>Details</p>')
        self.assertEqual(len(parser.images),1);self.assertEqual(parser.images[0]['url'],'https://mathworld.wolfram.com/images/ellipse.svg')
        svg=access.sanitize_svg(b'<svg xmlns="http://www.w3.org/2000/svg" onload="bad()"><script>bad()</script><foreignObject/><image href="https://private.example"/><path d="M0 0L1 1"/></svg>').decode()
        self.assertNotIn('script',svg);self.assertNotIn('foreignObject',svg);self.assertNotIn('onload',svg);self.assertNotIn('private.example',svg);self.assertIn('path',svg)
if __name__=='__main__':unittest.main()
