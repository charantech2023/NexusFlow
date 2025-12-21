import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Fix for TypeScript build error
declare const process: any;
declare const window: any;

// --- Types ---

interface ParsedArticle {
    title: string;
    url: string;
    type: string;
}

interface AnalysisResult {
    primary_topic: string;
    user_intent: string;
    content_stage: 'Awareness' | 'Consideration' | 'Decision'; 
    key_entities: string[];
}

interface Suggestion {
    suggestion_type: 'NEW' | 'REPLACEMENT';
    anchor_text: string;
    target_url: string;
    target_type: 'MONEY_PAGE' | 'STRATEGIC_PILLAR' | 'STANDARD_CONTENT';
    original_paragraph: string;
    paragraph_with_link: string;
    reasoning: string;
    strategy_tag: string;
}

interface ExistingLinkAudit {
    anchor_text: string;
    url: string;
    score: number;
    reasoning: string;
    recommendation: string;
}

interface InboundSuggestion {
    source_page_title: string;
    source_page_url: string;
    reasoning: string;
    suggested_anchor_text: string;
}

// --- Constants ---

const PROXIES = [
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

const SAVED_ARTICLES_KEY = 'nexusflow_saved_articles';
const DEFAULT_MONEY_PATTERNS = ['/product/', '/service/', '/pricing/', '/demo/', '/buy/', '/order/'];
const DEFAULT_PILLAR_PATTERNS = ['/guide/', '/pillar/', '/hub/', '/resource/', '/ultimate-guide/'];

const NOISE_SELECTORS = [
    'script', 'style', 'svg', 'iframe', 'nav', 'footer', 'header', 'aside', 'noscript',
    '.ad-container', '.menu', '.nav', '.sidebar', '.breadcrumbs', '.breadcrumb', 
    '.pagination', '.site-header', '.site-footer', '#sidebar', '#menu', '#nav', 
    '.widget-area', '.entry-meta', '.post-meta', '.cat-links', '.tags-links', 
    '.metadata', '.post-info', '.author-box', '.comment-respond', '.social-share',
    '.related-posts', '.newsletter-signup', '.disclaimer', '.cookie-banner',
    '[role="complementary"]', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]'
].join(', ');

const EXCLUDED_URL_PATTERNS = ['/author/', '/category/', '/tag/', '/search/', '/login', 'mailto:', 'tel:', 'javascript:', '#'];

// --- Helper Functions ---

const fetchWithProxyFallbacks = async (url: string): Promise<Response> => {
    let lastError = null;
    for (const proxy of PROXIES) {
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 15000); 
            const response = await fetch(proxy(url), { method: 'GET', signal: controller.signal });
            clearTimeout(id);
            if (response.ok) return response;
        } catch (e) { lastError = e; }
    }
    throw new Error(lastError ? `Access blocked. Use "Paste HTML" mode or check the URL.` : "Fetch failed.");
};

const getHostname = (urlString: string): string => {
  try { return new URL(urlString).hostname.replace('www.', ''); } catch (e) { return ''; }
};

const normalizeUrl = (urlString: string): string => {
  try {
    const url = new URL(urlString, window.location.origin);
    let pathname = url.pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return pathname;
  } catch (e) { return urlString.toLowerCase(); }
};

const extractJson = (text: string) => {
    try {
        const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        const jsonText = (match && match[1]) ? match[1] : text.trim();
        const start = jsonText.indexOf('{');
        const end = jsonText.lastIndexOf('}');
        if (start === -1 || end === -1) throw new Error("Invalid JSON structure");
        return JSON.parse(jsonText.substring(start, end + 1));
    } catch (e) {
        console.error("JSON Parse Error:", e, text);
        return { suggestions: [], audits: [] };
    }
};

const cleanToMarkdown = (html: string): string => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());
    
    let markdown = "";
    const walkers = document.createTreeWalker(tempDiv, NodeFilter.SHOW_ELEMENT);
    let node;
    while(node = walkers.nextNode()) {
        const el = node as HTMLElement;
        const tag = el.tagName;
        const text = el.innerText.trim();
        if (!text) continue;

        if (tag === 'H1') markdown += `\n# ${text}\n`;
        else if (tag === 'H2') markdown += `\n## ${text}\n`;
        else if (tag === 'H3') markdown += `\n### ${text}\n`;
        else if (tag === 'P' && text.length > 15) markdown += `${text}\n\n`;
        else if (tag === 'LI' && text.length > 5) markdown += `- ${text}\n`;
    }
    return markdown.trim().substring(0, 15000);
};

const extractInternalLinks = (html: string, baseDomain: string, inventory: ParsedArticle[]) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll(NOISE_SELECTORS).forEach(el => el.remove());
    const links: { anchor: string; url: string }[] = [];
    const invPaths = new Set(inventory.map(p => normalizeUrl(p.url)));

    tempDiv.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        const text = a.innerText.trim();
        if (href && text) {
            const isRelative = href.startsWith('/') || href.startsWith('#');
            const isSameDomain = baseDomain && href.includes(baseDomain);
            const inInventory = invPaths.has(normalizeUrl(href));
            
            if ((isRelative || isSameDomain || inInventory) && !EXCLUDED_URL_PATTERNS.some(p => href.includes(p))) {
                links.push({ anchor: text, url: href });
            }
        }
    });
    return links;
};

// --- Main App ---

const App = () => {
  const [step, setStep] = useState(1);
  const [inputMode, setInputMode] = useState('fetch');
  const [draftInput, setDraftInput] = useState('');
  const [draftUrl, setDraftUrl] = useState('');
  const [draftHtml, setDraftHtml] = useState('');
  const [isProcessingSource, setIsProcessingSource] = useState(false);
  const [sourceStatus, setSourceStatus] = useState({ message: '', type: '' });
  
  const [inventoryUrl, setInventoryUrl] = useState('');
  const [inventory, setInventory] = useState<ParsedArticle[]>([]);
  const [isProcessingInv, setIsProcessingInv] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [inbound, setInbound] = useState<InboundSuggestion[]>([]);
  const [audit, setAudit] = useState<ExistingLinkAudit[]>([]);
  const [isAnalysing, setIsAnalysing] = useState(false);
  const [activeTab, setActiveTab] = useState<'outbound' | 'inbound' | 'audit'>('outbound');

  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ARTICLES_KEY);
    if (saved) setInventory(JSON.parse(saved));
  }, []);

  const handleFetchDraft = async () => {
    if (!draftUrl) return;
    setIsProcessingSource(true);
    setSourceStatus({ message: 'Scrubbing noise & structure...', type: 'info' });
    try {
      const res = await fetchWithProxyFallbacks(draftUrl);
      const html = await res.text();
      setDraftHtml(html);
      setSourceStatus({ message: 'Source prepared.', type: 'success' });
    } catch (e) {
      setSourceStatus({ message: (e as Error).message, type: 'error' });
    } finally { setIsProcessingSource(false); }
  };

  const handleFetchInventory = async () => {
    if (!inventoryUrl) return;
    setIsProcessingInv(true);
    const discoveredUrls = new Set<string>();
    
    const parseSitemapString = (xmlText: string) => {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'text/xml');
        doc.querySelectorAll('url loc').forEach(loc => {
            const url = loc.textContent?.trim();
            if (url && url.startsWith('http')) discoveredUrls.add(url);
        });
        return Array.from(doc.querySelectorAll('sitemap loc'))
            .map(loc => loc.textContent?.trim())
            .filter(u => u && u.startsWith('http')) as string[];
    };

    try {
        const initialRes = await fetchWithProxyFallbacks(inventoryUrl);
        const subSitemaps = parseSitemapString(await initialRes.text());
        for (const sub of subSitemaps.slice(0, 15)) {
            try {
                const res = await fetchWithProxyFallbacks(sub);
                parseSitemapString(await res.text());
            } catch (e) { console.warn(`Sub-sitemap failed: ${sub}`); }
        }
        const items = Array.from(discoveredUrls).map(u => ({ 
            url: u, title: u.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || u, type: 'CONTENT' 
        }));
        setInventory(items);
        localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(items));
        alert(`Discovered ${items.length} pages.`);
    } catch (e) { alert("Sitemap fetch failed."); }
    finally { setIsProcessingInv(false); }
  };

  const handleCsvUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsProcessingInv(true);
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
      const newItems: ParsedArticle[] = lines.slice(1).map(line => {
        const parts = line.split(',');
        const url = parts[0]?.trim();
        const title = parts[1]?.trim() || url.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || url;
        return { url, title, type: 'CONTENT' };
      }).filter(item => item.url.startsWith('http'));
      
      setInventory(newItems);
      localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(newItems));
      setIsProcessingInv(false);
      alert(`Imported ${newItems.length} pages from CSV.`);
    };
    reader.readAsText(file);
  };

  const runAnalysis = async () => {
    setIsAnalysing(true);
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const raw = inputMode === 'fetch' ? draftHtml : draftInput;
    const md = cleanToMarkdown(raw);
    const internalLinks = extractInternalLinks(raw, getHostname(draftUrl), inventory);
    const internalUrls = internalLinks.map(l => normalizeUrl(l.url));

    try {
        const task1 = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `Identify Funnel & Entities:
            CONTENT:
            ${md}
            Return JSON: { "primary_topic", "user_intent", "content_stage", "key_entities": [] }`,
            config: { responseMimeType: 'application/json' }
        });
        const res1 = extractJson(task1.text);
        setAnalysis(res1);

        const sampledInventory = inventory.slice(0, 100).map(p => ({ 
            url: p.url, title: p.title, 
            type: DEFAULT_MONEY_PATTERNS.some(m => p.url.includes(m)) ? 'MONEY_PAGE' : DEFAULT_PILLAR_PATTERNS.some(pp => p.url.includes(pp)) ? 'STRATEGIC_PILLAR' : 'CONTENT' 
        }));

        const task2 = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `TASK: Find natural "Bridge" anchors.
            STAGE: ${res1.content_stage}
            INVENTORY: ${JSON.stringify(sampledInventory)}
            CONTENT:
            ${md}
            STRICT RULES:
            1. DO NOT MODIFY THE TEXT. The "anchor_text" MUST be a verbatim character match in "original_paragraph".
            2. Link to Decision pages if stage is Decision.
            Return JSON: { "suggestions": [{ "anchor_text", "target_url", "target_type", "original_paragraph", "paragraph_with_link", "reasoning", "strategy_tag" }] }`,
            config: { responseMimeType: 'application/json' }
        });
        const res2 = extractJson(task2.text);
        
        // Verbatim Verification
        const validatedSuggestions = (res2.suggestions || []).filter((s: Suggestion) => {
            const verbatim = md.includes(s.anchor_text) && s.original_paragraph.includes(s.anchor_text);
            const fresh = !internalUrls.includes(normalizeUrl(s.target_url));
            return verbatim && fresh;
        });
        setSuggestions(validatedSuggestions);

        const [auditTask, inboundTask] = await Promise.all([
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Audit internal links in "${res1.primary_topic}": ${JSON.stringify(internalLinks)}. JSON: { "audits": [{ "anchor_text", "url", "score", "reasoning", "recommendation" }] }`,
              config: { responseMimeType: 'application/json' }
          }),
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Suggest 5 inventory pages to link TO "${res1.primary_topic}". Pool: ${JSON.stringify(sampledInventory)}. JSON: { "suggestions": [{ "source_page_title", "source_page_url", "reasoning", "suggested_anchor_text" }] }`,
              config: { responseMimeType: 'application/json' }
          })
        ]);
        setAudit(extractJson(auditTask.text).audits || []);
        setInbound(extractJson(inboundTask.text).suggestions || []);
    } catch (e) {
        alert("Strategic analysis failed.");
    } finally { setIsAnalysing(false); }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>NexusFlow AI ⚡</h1>
        <p>Enterprise Site Architecture & Journey Optimization</p>
      </header>

      <div className="progress-indicator">
        {[1, 2, 3, 4].map(s => (
          <React.Fragment key={s}>
            <div className={`pi-step ${step >= s ? 'active' : ''}`}>{s}</div>
            {s < 4 && <div className="pi-line" style={{background: step > s ? 'var(--primary-color)' : '#e2e8f0'}}></div>}
          </React.Fragment>
        ))}
      </div>

      <div className="content-body">
        {step === 1 && (
          <div className="wizard-step">
            <h2>1. Source Draft</h2>
            <div className="radio-group" style={{marginBottom: '1rem'}}>
                <label className={inputMode === 'fetch' ? 'active' : ''}>
                    <input type="radio" checked={inputMode === 'fetch'} onChange={() => setInputMode('fetch')} /> Fetch URL
                </label>
                <label className={inputMode === 'paste' ? 'active' : ''} style={{marginLeft:'20px'}}>
                    <input type="radio" checked={inputMode === 'paste'} onChange={() => setInputMode('paste')} /> Paste HTML
                </label>
            </div>
            {inputMode === 'fetch' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://..." value={draftUrl} onChange={e => setDraftUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={handleFetchDraft} disabled={isProcessingSource}>Scrub</button>
                </div>
            ) : <textarea className="input" placeholder="Paste HTML draft..." value={draftInput} onChange={e => setDraftInput(e.target.value)} />}
            {sourceStatus.message && <div className={`status-message ${sourceStatus.type}`}>{sourceStatus.message}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Target Inventory</h2>
            
            <div className="inventory-grid" style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px'}}>
                <div className="inv-method">
                    <label style={{display:'block', marginBottom:'10px', fontWeight:700, fontSize:'0.8rem'}}>METHOD A: XML SITEMAP</label>
                    <div className="input-group" style={{flexDirection:'column'}}>
                        <input type="text" className="input" placeholder="https://.../sitemap_index.xml" value={inventoryUrl} onChange={e => setInventoryUrl(e.target.value)} />
                        <button className="btn btn-secondary" style={{marginTop:'5px'}} onClick={handleFetchInventory} disabled={isProcessingInv}>Recurse XML</button>
                    </div>
                </div>
                <div className="inv-method">
                    <label style={{display:'block', marginBottom:'10px', fontWeight:700, fontSize:'0.8rem'}}>METHOD B: CSV UPLOAD</label>
                    <div className="csv-upload-box" onClick={() => fileInputRef.current?.click()}>
                        <span>{isProcessingInv ? 'Reading...' : 'Click to Upload CSV (URL, Title)'}</span>
                        <input type="file" ref={fileInputRef} hidden accept=".csv" onChange={handleCsvUpload} />
                    </div>
                </div>
            </div>
            <p style={{marginTop:'1.5rem', textAlign:'center', fontSize:'0.9rem', color:'var(--text-muted)'}}>
                Currently Mapping: <strong>{inventory.length}</strong> strategic pages.
            </p>
          </div>
        )}

        {step === 3 && (
            <div className="wizard-step">
                <h2>3. Strategy Guardrails</h2>
                <div className="review-box" style={{borderLeftColor:'var(--success-color)'}}>
                    <strong>Active Protocol: Bridge Anchor Logic</strong>
                    <p style={{marginTop:'10px'}}>We scan your draft for verbatim phrases that naturally link to target inventory. No text is rewritten or "hallucinated."</p>
                </div>
            </div>
        )}

        {step === 4 && (
            <div className="wizard-step">
                {!isAnalysing && suggestions.length === 0 && (
                    <div style={{textAlign:'center', padding:'3rem'}}>
                        <button className="btn btn-primary" style={{padding:'1rem 5rem'}} onClick={runAnalysis}>Run Strategic Analysis</button>
                    </div>
                )}
                {isAnalysing && <div style={{textAlign:'center', padding:'3rem'}}><span className="spinner"></span><p>Architecting journey paths...</p></div>}

                {analysis && !isAnalysing && (
                    <div className="results-container">
                        <div className="strategy-dashboard">
                            <div className="sd-card"><span className="sd-label">Stage</span><div className="sd-value">{analysis.content_stage}</div></div>
                            <div className="sd-card"><span className="sd-label">Topic</span><div className="sd-value">{analysis.primary_topic}</div></div>
                            <div className="sd-card"><span className="sd-label">Entities</span><div className="sd-value" style={{fontSize:'0.75rem'}}>{analysis.key_entities.join(', ')}</div></div>
                        </div>

                        <div className="tabs-header">
                            <button className={`tab-btn ${activeTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveTab('outbound')}>Strategic Bridges ({suggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveTab('inbound')}>Inbound Sources ({inbound.length})</button>
                            <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>Draft Health ({audit.length})</button>
                        </div>

                        {activeTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>"{s.anchor_text}"</h3>
                                            <span className={`badge ${s.target_type === 'MONEY_PAGE' ? 'badge-money' : 'badge-pillar'}`}>{s.target_type}</span>
                                        </div>
                                        <p style={{fontSize:'0.85rem', marginBottom:'10px'}}>Target: <a href={s.target_url} target="_blank">{s.target_url}</a></p>
                                        <div className="suggestion-context">
                                            <div style={{fontSize:'0.6rem', fontWeight:800, marginBottom:'5px', opacity:0.6}}>VERBATIM CONTEXT:</div>
                                            <span dangerouslySetInnerHTML={{__html: s.paragraph_with_link}} />
                                        </div>
                                        <div style={{marginTop:'1rem', fontSize:'0.85rem'}}><strong>Logic:</strong> {s.reasoning}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'inbound' && (
                             <div className="tab-content">
                                {inbound.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header"><h3>From: {s.source_page_title}</h3></div>
                                        <p style={{fontSize:'0.85rem'}}><a href={s.source_page_url} target="_blank">{s.source_page_url}</a></p>
                                        <div className="suggestion-context">Anchor: "{s.suggested_anchor_text}"<br/>Why: {s.reasoning}</div>
                                    </div>
                                ))}
                             </div>
                        )}

                        {activeTab === 'audit' && (
                             <div className="tab-content">
                                {audit.map((a, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header"><h3>"{a.anchor_text}"</h3><span>{a.score}% Quality</span></div>
                                        <div className="suggestion-context">{a.recommendation}</div>
                                    </div>
                                ))}
                             </div>
                        )}
                    </div>
                )}
            </div>
        )}
      </div>

      <div className="navigation-buttons">
            <button className="btn btn-secondary" onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1 || isAnalysing}>Back</button>
            {step < 4 && <button className="btn btn-primary" onClick={() => setStep(s => Math.min(4, s + 1))} disabled={step === 1 ? (!draftHtml && !draftInput) : step === 2 ? inventory.length === 0 : false}>Next</button>}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);