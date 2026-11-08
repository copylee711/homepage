import { readFileSync } from 'node:fs';

// Curated teaching figures. Verify the original file, caption and license before adding entries.
const figures = [
  {
    "title": "高斯定律：球面内的电荷",
    "description": "球形高斯面包围一个点电荷，适合说明封闭曲面与净包围电荷。",
    "author": "Chanchocan (original), Nicoguaro (vector)",
    "license": "CC BY-SA 3.0",
    "aliases": [
      "高斯定律",
      "高斯定理",
      "gauss law",
      "gauss s law",
      "gaussian surface"
    ],
    "url": "https://upload.wikimedia.org/wikipedia/commons/b/b8/Gauss_Sphere_Charge_Inside.svg",
    "sourceUrl": "https://commons.wikimedia.org/wiki/File:Gauss_Sphere_Charge_Inside.svg"
  },
  {
    "title": "向量场沿有向曲线的积分",
    "description": "动画将切向速度与向量场的点积可视化，适合解释第二类曲线积分。",
    "author": "Lucas Vieira (LucasVB)",
    "license": "Public domain",
    "aliases": [
      "第二类曲线积分",
      "向量场线积分",
      "向量场的线积分",
      "vector line integral",
      "line integral of vector field",
      "line integral of a vector field"
    ],
    "url": "https://upload.wikimedia.org/wikipedia/commons/b/b0/Line_integral_of_vector_field.gif",
    "sourceUrl": "https://commons.wikimedia.org/wiki/File:Line_integral_of_vector_field.gif"
  },
  {
    "title": "细胞膜的流动镶嵌模型",
    "description": "磷脂双层及膜蛋白的带标签结构图。",
    "author": "Mariana Ruiz (LadyofHats)",
    "license": "Public domain",
    "aliases": [
      "流动镶嵌模型",
      "细胞膜结构",
      "磷脂双分子层",
      "fluid mosaic model",
      "cell membrane structure",
      "phospholipid bilayer"
    ],
    "url": "https://upload.wikimedia.org/wikipedia/commons/d/da/Cell_membrane_detailed_diagram_en.svg",
    "sourceUrl": "https://commons.wikimedia.org/wiki/File:Cell_membrane_detailed_diagram_en.svg"
  }
];

function normalize(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const wikiDirectory = new URL('../openwiki/iris-figures/', import.meta.url);
const domains = ['mathematics', 'physics', 'biology'];

export function subjectSites(subject) {
  if (!domains.includes(subject)) return [];
  const page = readFileSync(new URL(subject + '.md', wikiDirectory), 'utf8');
  return [...new Set([...page.matchAll(/^- \[[^\]\n]+\]\((https:\/\/[^)\s]+)\)/gm)]
    .map(([, url]) => new URL(url).hostname))].slice(0, 3);
}

function matchFigures(text, count) {
  const query = normalize(text);
  return figures
    .map(({ aliases, ...figure }) => ({
      figure,
      score: Math.max(0, ...aliases.map(alias => {
        const phrase = normalize(alias);
        const matched = /\p{Script=Han}/u.test(phrase)
          ? query.includes(phrase)
          : ` ${query} `.includes(` ${phrase} `);
        return matched ? (query === phrase ? 1000 : 0) + phrase.length : 0;
      })),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map(({ figure }) => figure);
}

export function figureContext(prompt) {
  if (typeof prompt !== 'string' || /(?:纯文字|只用文字|不要配图|不需要配图|text[- ]only|no (?:images|pictures|figures|visuals))/i.test(prompt)) return '';
  const results = matchFigures(prompt, 1);
  if (!results.length) return '';
  return '\nA curated teaching figure matches the latest user prompt: ' + JSON.stringify(results[0]) +
    '. If the task is a concept explanation and this figure explains it, embed it directly in Markdown beside the relevant paragraph, with its source link and credit. No lookup or preview is needed. Respect the user’s requested format.';
}

export async function searchImages(params, externalSearch) {
  if (!params.externalOnly) {
    const results = matchFigures(params.query, params.count ?? 5);
    if (results.length) return { status: 'ok', engine: 'iris-figure-catalog', query: params.query, results };
  }
  const sites = params.externalOnly ? [] : subjectSites(params.subject);
  return externalSearch({ query: params.query, count: params.count, category: 'image', ...(sites.length ? { sites } : {}) });
}
