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
if __name__=='__main__':unittest.main()
