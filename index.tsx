import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Fix for TypeScript build error: "Cannot find name 'process' or 'window'"
declare const process: any;
declare const window: any;

// --- Types ---

interface ParsedArticle {
    title: string;
    url: string;
    type: string;
    description?: string;
    h1?: string;
    h2s?: string[];
    h3s?: string[];
    keyword?: string;
}

interface AnalysisResult {
    primary_topic: string;
    user_intent: string;
    content_stage: string; 
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
    is_paa_match?: boolean;
    matched_paa_question?: string;
}

interface ExistingLinkAudit {
    anchor_text: string;
    url: string;
    score: number;
    relevance_score: number;
    anchor_score: number;
    flow_score: number;
    reasoning: string;
    recommendation: string;
    is_duplicate: boolean;
}

interface InboundSuggestion {
    source_page_title: string;
    source_page_url: string;
    relevance_score: number;
    reasoning: string;
    suggested_anchor_text: string;
}

interface GroundingChunk {
  web?: {
    uri: string;
    title: string;
  };
}

// --- Constants ---

const PROXIES = [
    (url: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const SAVED_ARTICLES_KEY = 'nexusflow_saved_articles';
const DEFAULT_MONEY_PATTERNS = ['/product/', '/service/', '/pricing/', '/demo/', '/buy/', '/order/'];
const DEFAULT_PILLAR_PATTERNS = ['/guide/', '/pillar/', '/hub/', '/resource/', '/ultimate-guide/'];

const NAV_SELECTORS = 'script, style, svg, iframe, nav, footer, header, aside, noscript, .ad-container, .menu, .nav, .sidebar, .breadcrumbs, .breadcrumb, .pagination, .site-header, .site-footer, #sidebar, #menu, #nav, .widget-area, .entry-meta, .post-meta, .cat-links, .tags-links, .metadata, .post-info, .author-box, .comment-respond';

const EXCLUDED_URL_PATTERNS = [
    '/author/', '/category/', '/tag/', '/search/', '/login', '/signup', '/register', 
    '/privacy-policy', '/terms-of-service', '/contact', '/about', '/comments', 
    '/feed/', 'mailto:', 'tel:', 'javascript:', '#'
];

// --- Helper Functions ---

const fetchWithProxyFallbacks = async (url: string): Promise<Response> => {
    for (let i = 0; i < PROXIES.length; i++) {
        const proxyUrl = PROXIES[i](url);
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 12000);
            const response = await fetch(proxyUrl, { method: 'GET', signal: controller.signal });
            clearTimeout(id);
            if (response.ok) return response;
        } catch (e) { console.warn(`Proxy ${i} failed for ${url}`); }
    }
    throw new Error(`Unable to fetch. Please check your URL.`);
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
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let jsonText = (match && match[1]) ? match[1] : text.trim();
    const startIndex = jsonText.indexOf('{');
    const endIndex = jsonText.lastIndexOf('}');
    if (startIndex === -1 || endIndex === -1) {
        const bracketStart = jsonText.indexOf('[');
        const bracketEnd = jsonText.lastIndexOf(']');
        if (bracketStart === -1) throw new Error("No JSON found.");
        return JSON.parse(jsonText.substring(bracketStart, bracketEnd + 1));
    }
    return JSON.parse(jsonText.substring(startIndex, endIndex + 1));
};

const toCompactContent = (html: string) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll(NAV_SELECTORS).forEach(el => el.remove());
    let text = "";
    const walkers = document.createTreeWalker(tempDiv, NodeFilter.SHOW_ELEMENT);
    let node;
    while(node = walkers.nextNode()) {
        const el = node as HTMLElement;
        if(['H1', 'H2', 'H3'].includes(el.tagName)) text += `\n# ${el.innerText}\n`;
        else if(el.tagName === 'P' && el.innerText.length > 20) text += `${el.innerText}\n\n`;
    }
    return text.substring(0, 15000);
};

const extractExistingLinks = (html: string) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll(NAV_SELECTORS).forEach(el => el.remove());
    const links: { anchor: string; url: string }[] = [];
    tempDiv.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        const text = a.innerText.trim();
        if (href && text && (href.startsWith('http') || href.startsWith('/'))) {
            const isExcluded = EXCLUDED_URL_PATTERNS.some(p => href.toLowerCase().includes(p.toLowerCase()));
            if (!isExcluded) links.push({ anchor: text, url: href });
        }
    });
    return links.slice(0, 30);
};

// --- Main App ---

const App = () => {
  const [step, setStep] = useState(1);
  const [mainArticleInputMode, setMainArticleInputMode] = useState('fetch');
  const [mainArticle, setMainArticle] = useState('');
  const [mainArticleUrl, setMainArticleUrl] = useState('');
  const [mainArticleHtml, setMainArticleHtml] = useState('');
  const [isProcessingMain, setIsProcessingMain] = useState(false);
  const [mainArticleStatus, setMainArticleStatus] = useState({ message: '', type: '' });
  
  const [inventoryInputMode, setInventoryInputMode] = useState<'sitemap' | 'file'>('sitemap');
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [parsedArticles, setParsedArticles] = useState<ParsedArticle[]>([]);
  const [existingPagesStatus, setExistingPagesStatus] = useState({ message: '', type: '' });
  const [isProcessingInventory, setIsProcessingInventory] = useState(false);

  const [moneyPatterns, setMoneyPatterns] = useState(DEFAULT_MONEY_PATTERNS);
  const [pillarPatterns, setPillarPatterns] = useState(DEFAULT_PILLAR_PATTERNS);

  const [currentAnalysisResult, setCurrentAnalysisResult] = useState<AnalysisResult | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [inboundSuggestions, setInboundSuggestions] = useState<InboundSuggestion[]>([]);
  const [existingAudits, setExistingAudits] = useState<ExistingLinkAudit[]>([]);
  const [groundingLinks, setGroundingLinks] = useState<{title: string, uri: string}[]>([]);
  const [isAnalysisRunning, setIsAnalysisRunning] = useState(false);
  const [currentPhase, setCurrentPhase] = useState('');
  const [activeTab, setActiveTab] = useState<'outbound' | 'inbound' | 'audit'>('outbound');

  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ARTICLES_KEY);
    if (saved) setParsedArticles(JSON.parse(saved));
  }, []);

  const processInventory = (content: string, type: 'xml' | 'csv') => {
    try {
      setExistingPagesStatus({ message: 'Parsing inventory...', type: 'info' });
      let articles: ParsedArticle[] = [];
      if (type === 'xml') {
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(content, 'text/xml');
        const urls = Array.from(xmlDoc.querySelectorAll('url loc')).map(el => el.textContent || '');
        articles = urls.filter(u => u && !EXCLUDED_URL_PATTERNS.some(p => u.includes(p))).map(u => ({
          title: u.split('/').filter(Boolean).pop()?.replace(/-/g, ' ').replace(/\.[^/.]+$/, "") || u,
          url: u,
          type: 'CONTENT'
        }));
      } else {
        const lines = content.split('\n');
        articles = lines.filter(l => l.trim()).map(l => {
          const parts = l.split(',');
          return {
            title: parts[0]?.trim() || 'Untitled',
            url: parts[1]?.trim() || parts[0]?.trim(),
            type: 'CONTENT'
          };
        }).filter(a => a.url && !EXCLUDED_URL_PATTERNS.some(p => a.url.includes(p)));
      }

      if (articles.length === 0) throw new Error("No valid articles found in inventory.");

      setParsedArticles(articles);
      localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(articles));
      setExistingPagesStatus({ message: `Successfully loaded ${articles.length} pages.`, type: 'success' });
    } catch (e) {
      setExistingPagesStatus({ message: (e as Error).message, type: 'error' });
    }
  };

  const handleFetchArticle = async () => {
    if (!mainArticleUrl) return;
    setIsProcessingMain(true);
    setMainArticleStatus({ message: 'Fetching...', type: 'info' });
    try {
      const response = await fetchWithProxyFallbacks(mainArticleUrl);
      setMainArticleHtml(await response.text());
      setMainArticleStatus({ message: 'Success!', type: 'success' });
    } catch (e) {
      setMainArticleStatus({ message: (e as Error).message, type: 'error' });
    } finally { setIsProcessingMain(false); }
  };

  const runFastAnalysis = async () => {
    setIsAnalysisRunning(true);
    setCurrentPhase('Initializing Analysis...');
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const rawContent = mainArticleInputMode === 'fetch' ? mainArticleHtml : mainArticle;
    const compactContent = toCompactContent(rawContent);
    const existingLinks = extractExistingLinks(rawContent);
    const existingUrls = existingLinks.map(l => normalizeUrl(l.url));
    const targetOutboundCount = Math.min(15, Math.max(3, Math.ceil(compactContent.split(/\s+/).length / 250)));

    try {
        setCurrentPhase('Identifying People Also Ask questions...');
        const [classTask, paaTask] = await Promise.all([
          ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: `Analyze Content Role:\n${compactContent.substring(0, 5000)}\nReturn JSON: { "primary_topic", "user_intent", "content_stage": "Awareness|Consideration|Decision", "key_entities": [] }`,
              config: { responseMimeType: 'application/json' }
          }),
          ai.models.generateContent({
              model: 'gemini-2.5-flash',
              contents: `Search for top 5 'People Also Ask' questions related to: "${compactContent.substring(0, 500)}".`,
              config: { tools: [{googleSearch: {}}] }
          })
        ]);

        const analysis = extractJson(classTask.text);
        setCurrentAnalysisResult(analysis);
        
        const groundingChunks = (paaTask.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingChunk[]) || [];
        setGroundingLinks(groundingChunks.filter(c => c.web).map(c => ({ title: c.web!.title, uri: c.web!.uri })));
        const paaQuestionsText = paaTask.text;

        setCurrentPhase(`Architecting Link Journeys...`);
        const searchPool = parsedArticles.slice(0, 50).map(p => ({ 
            url: p.url, title: p.title, 
            type: moneyPatterns.some(m => p.url.includes(m)) ? 'MONEY_PAGE' : pillarPatterns.some(pp => p.url.includes(pp)) ? 'STRATEGIC_PILLAR' : 'CONTENT' 
        }));

        const [outboundTask, inboundTask, auditTask] = await Promise.allSettled([
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Context: Internal Linking Architecture.
                Topic: ${analysis.primary_topic} | PAA Context: ${paaQuestionsText}
                Existing Linked URLs: ${JSON.stringify(existingUrls)}
                Task: Find ${targetOutboundCount} NEW logical link placements.
                Inventory: ${JSON.stringify(searchPool)}
                Rules: Use "Bridge" anchors. If matching a PAA question, cite it.
                Return JSON: { "suggestions": [{ "anchor_text", "target_url", "target_type", "original_paragraph", "paragraph_with_link", "reasoning", "strategy_tag", "is_paa_match", "matched_paa_question" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Inventory: ${JSON.stringify(parsedArticles.slice(0, 40).map(p => ({ title: p.title, url: p.url })))}
                Return JSON of 5 inbound link ideas to: "${analysis.primary_topic}". { "suggestions": [{ "source_page_title", "source_page_url", "reasoning", "suggested_anchor_text" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: `Audit these links for SEO quality: ${JSON.stringify(existingLinks)}. Topic: "${analysis.primary_topic}".
                Return JSON: { "audits": [{ "anchor_text", "url", "score", "relevance_score", "anchor_score", "flow_score", "reasoning", "recommendation", "is_duplicate" }] }`,
                config: { responseMimeType: 'application/json' }
            })
        ]);

        if (outboundTask.status === 'fulfilled') {
            const raw = extractJson(outboundTask.value.text).suggestions || [];
            setSuggestions(raw.filter((s: Suggestion) => !existingUrls.includes(normalizeUrl(s.target_url))));
        }
        if (inboundTask.status === 'fulfilled') setInboundSuggestions(extractJson(inboundTask.value.text).suggestions || []);
        if (auditTask.status === 'fulfilled') setExistingAudits(extractJson(auditTask.value.text).audits || []);

        setCurrentPhase('Analysis Complete.');
    } catch (e) {
        console.error(e);
        const errorMsg = (e as Error).message;
        setCurrentPhase('Analysis failed: ' + errorMsg);
    } finally { setIsAnalysisRunning(false); }
  };

  const copyToClipboard = (type: 'markdown' | 'html') => {
      let content = "";
      if (type === 'markdown') {
          content = `# NexusFlow SEO Report: ${currentAnalysisResult?.primary_topic}\n\n`;
          content += `## Topic Analysis\n- Topic: ${currentAnalysisResult?.primary_topic}\n- Intent: ${currentAnalysisResult?.user_intent}\n- Stage: ${currentAnalysisResult?.content_stage}\n\n`;
          content += `## Strategic Outbound Recommendations\n`;
          suggestions.forEach(s => content += `- [ ] **${s.anchor_text}** linking to ${s.target_url} (${s.strategy_tag})\n  - Reasoning: ${s.reasoning}\n\n`);
      } else {
          suggestions.forEach(s => content += `${s.paragraph_with_link}\n\n`);
      }
      navigator.clipboard.writeText(content);
      alert(`${type.toUpperCase()} Report copied to clipboard!`);
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>NexusFlow AI ⚡</h1>
        <p>Enterprise Internal Link Optimization</p>
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
                <label><input type="radio" checked={mainArticleInputMode === 'fetch'} onChange={() => setMainArticleInputMode('fetch')} /> Fetch URL</label>
                <label style={{marginLeft:'20px'}}><input type="radio" checked={mainArticleInputMode === 'paste'} onChange={() => setMainArticleInputMode('paste')} /> Paste Draft</label>
            </div>
            {mainArticleInputMode === 'fetch' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://..." value={mainArticleUrl} onChange={e => setMainArticleUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={handleFetchArticle} disabled={isProcessingMain}>Fetch</button>
                </div>
            ) : <textarea className="input" placeholder="Paste HTML or Text here..." value={mainArticle} onChange={e => setMainArticle(e.target.value)} />}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Link Inventory</h2>
            <div className="radio-group" style={{marginBottom: '1.5rem'}}>
                <label><input type="radio" checked={inventoryInputMode === 'sitemap'} onChange={() => setInventoryInputMode('sitemap')} /> Sitemap XML URL</label>
                <label style={{marginLeft:'20px'}}><input type="radio" checked={inventoryInputMode === 'file'} onChange={() => setInventoryInputMode('file')} /> Upload CSV/XML</label>
            </div>
            {inventoryInputMode === 'sitemap' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://..." value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={async () => {
                        setIsProcessingInventory(true);
                        try {
                            const res = await fetchWithProxyFallbacks(sitemapUrl);
                            processInventory(await res.text(), 'xml');
                        } catch (e) {
                          setExistingPagesStatus({ message: (e as Error).message, type: 'error' });
                        } finally { setIsProcessingInventory(false); }
                    }} disabled={isProcessingInventory}>Load</button>
                </div>
            ) : <input type="file" className="input" onChange={e => {
                const f = e.target.files?.[0];
                if (f) {
                    const r = new FileReader();
                    r.onload = ev => processInventory(ev.target?.result as string, f.name.endsWith('.csv') ? 'csv' : 'xml');
                    r.readAsText(f);
                }
            }} />}
            {existingPagesStatus.message && <div className={`status-message ${existingPagesStatus.type}`}>{existingPagesStatus.message}</div>}
          </div>
        )}

        {step === 3 && (
            <div className="wizard-step">
                <h2>3. Strategic Parameters</h2>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px'}}>
                    <div className="review-box" style={{borderLeftColor:'#8b5cf6'}}>
                        <strong>💰 Money Page Identifiers</strong>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'5px'}}>
                            {moneyPatterns.map(p => <span key={p} className="badge badge-money">{p}</span>)}
                        </div>
                    </div>
                    <div className="review-box" style={{borderLeftColor:'#06b6d4'}}>
                        <strong>🏛️ Pillar Hub Identifiers</strong>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'5px'}}>
                            {pillarPatterns.map(p => <span key={p} className="badge badge-pillar">{p}</span>)}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {step === 4 && (
            <div className="wizard-step">
                {!isAnalysisRunning && suggestions.length === 0 && (
                    <div style={{textAlign:'center', padding:'3rem'}}>
                        <button className="btn btn-primary" style={{padding:'1rem 3rem'}} onClick={runFastAnalysis}>Launch Link Analysis</button>
                    </div>
                )}
                
                {isAnalysisRunning && (
                    <div style={{textAlign:'center', padding:'3rem'}}>
                        <span className="spinner"></span>
                        <p style={{marginTop:'1rem', fontWeight:600}}>{currentPhase}</p>
                    </div>
                )}

                {currentAnalysisResult && !isAnalysisRunning && (
                    <div className="results-container">
                        <div className="strategy-dashboard">
                            <div className="sd-card">
                                <span className="sd-label">Topic</span>
                                <div className="sd-value">{currentAnalysisResult.primary_topic}</div>
                            </div>
                            <div className="sd-card"><span className="sd-label">Intent</span><div className="sd-value">{currentAnalysisResult.user_intent}</div></div>
                            <div className="sd-card"><span className="sd-label">Funnel</span><div className="sd-value" style={{color:'var(--primary-color)'}}>{currentAnalysisResult.content_stage}</div></div>
                        </div>

                        <div style={{display:'flex', gap:'10px', marginBottom:'2rem'}}>
                            <button className="btn btn-secondary" onClick={() => copyToClipboard('markdown')}>Copy Markdown Report</button>
                            <button className="btn btn-secondary" onClick={() => copyToClipboard('html')}>Copy HTML Snippet</button>
                        </div>

                        <div className="tabs-header">
                            <button className={`tab-btn ${activeTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveTab('outbound')}>Strategic Outbound ({suggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveTab('inbound')}>Inbound Backlinks ({inboundSuggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>Audit ({existingAudits.length})</button>
                        </div>

                        {activeTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
                                              <h3>{s.anchor_text}</h3>
                                              {s.is_paa_match && <span className="badge" style={{background:'var(--success-color)'}}>Verified Connection</span>}
                                            </div>
                                            <span className={`badge ${s.target_type === 'MONEY_PAGE' ? 'badge-money' : s.target_type === 'STRATEGIC_PILLAR' ? 'badge-pillar' : 'new'}`}>{s.target_type}</span>
                                        </div>
                                        <p style={{fontSize:'0.85rem', marginBottom:'10px'}}>Target: <a href={s.target_url} target="_blank">{s.target_url}</a></p>
                                        <div className="suggestion-context" style={{borderLeftColor: s.is_paa_match ? 'var(--success-color)' : 'var(--accent-color)'}}>
                                            <strong>Contextual Logic:</strong> {s.reasoning}
                                        </div>
                                        <div style={{marginTop:'1rem', fontSize:'0.9rem'}} dangerouslySetInnerHTML={{__html: s.paragraph_with_link}} />
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'audit' && (
                            <div className="tab-content">
                                {existingAudits.map((a, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>"{a.anchor_text}"</h3>
                                            <div style={{fontWeight:'bold', color: a.score > 80 ? 'var(--success-color)' : 'var(--error-color)'}}>{a.score}% Health</div>
                                        </div>
                                        <p style={{fontSize:'0.85rem'}}>URL: {a.url}</p>
                                        <div className="suggestion-context" style={{marginTop:'10px'}}>{a.recommendation}</div>
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
            <button className="btn btn-secondary" onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1 || isAnalysisRunning}>Back</button>
            {step < 4 && <button className="btn btn-primary" onClick={() => setStep(s => Math.min(4, s + 1))} disabled={step === 1 ? !mainArticleHtml && !mainArticle : step === 2 ? parsedArticles.length === 0 : false}>Next</button>}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);