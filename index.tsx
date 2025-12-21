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
    (url: string) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
    (url: string) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

const SAVED_ARTICLES_KEY = 'nexusflow_saved_articles';
const DEFAULT_MONEY_PATTERNS = ['/product/', '/service/', '/pricing/', '/demo/', '/buy/', '/order/'];
const DEFAULT_PILLAR_PATTERNS = ['/guide/', '/pillar/', '/hub/', '/resource/', '/ultimate-guide/'];

// Expanded noise removal selectors
const NAV_SELECTORS = [
    'script', 'style', 'svg', 'iframe', 'nav', 'footer', 'header', 'aside', 'noscript',
    '.ad-container', '.menu', '.nav', '.sidebar', '.breadcrumbs', '.breadcrumb', 
    '.pagination', '.site-header', '.site-footer', '#sidebar', '#menu', '#nav', 
    '.widget-area', '.entry-meta', '.post-meta', '.cat-links', '.tags-links', 
    '.metadata', '.post-info', '.author-box', '.comment-respond', '.social-share',
    '.related-posts', '.newsletter-signup', '.disclaimer', '.cookie-banner'
].join(', ');

const EXCLUDED_URL_PATTERNS = [
    '/author/', '/category/', '/tag/', '/search/', '/login', '/signup', '/register', 
    '/privacy-policy', '/terms-of-service', '/contact', '/about', '/comments', 
    '/feed/', 'mailto:', 'tel:', 'javascript:', '#'
];

// --- Helper Functions ---

const fetchWithProxyFallbacks = async (url: string): Promise<Response> => {
    let lastError = null;
    for (let i = 0; i < PROXIES.length; i++) {
        const proxyUrl = PROXIES[i](url);
        try {
            const controller = new AbortController();
            const id = setTimeout(() => controller.abort(), 15000); 
            const response = await fetch(proxyUrl, { 
                method: 'GET', 
                signal: controller.signal,
                headers: { 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9' }
            });
            clearTimeout(id);
            if (response.ok) return response;
        } catch (e) { 
            lastError = e;
        }
    }
    throw new Error(lastError ? `Fetch failed. Target site might be blocking access. Try pasting manually.` : "Fetch failed.");
};

const getHostname = (urlString: string): string => {
  try {
    return new URL(urlString).hostname.replace('www.', '');
  } catch (e) { return ''; }
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

/**
 * Clean HTML and convert to structured Markdown for AI analysis.
 * Preserves H1, H2, H3 and Main Body while removing noise.
 */
const toCompactContent = (html: string) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    // Strict Noise Removal
    tempDiv.querySelectorAll(NAV_SELECTORS).forEach(el => el.remove());
    
    let markdown = "";
    const walkers = document.createTreeWalker(tempDiv, NodeFilter.SHOW_ELEMENT);
    let node;
    while(node = walkers.nextNode()) {
        const el = node as HTMLElement;
        const tagName = el.tagName;
        const text = el.innerText.trim();
        
        if (!text) continue;

        if (tagName === 'H1') markdown += `\n# ${text}\n`;
        else if (tagName === 'H2') markdown += `\n## ${text}\n`;
        else if (tagName === 'H3') markdown += `\n### ${text}\n`;
        else if (tagName === 'P' && text.length > 20) {
            // Only add paragraphs that look like actual body content
            markdown += `${text}\n\n`;
        } else if ((tagName === 'LI') && text.length > 5) {
            markdown += `- ${text}\n`;
        }
    }
    
    return markdown.substring(0, 15000);
};

const extractExistingLinks = (html: string, baseDomain: string, inventory: ParsedArticle[]) => {
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    tempDiv.querySelectorAll(NAV_SELECTORS).forEach(el => el.remove());
    const links: { anchor: string; url: string }[] = [];
    const inventoryPaths = new Set(inventory.map(p => normalizeUrl(p.url)));

    tempDiv.querySelectorAll('a').forEach(a => {
        const href = a.getAttribute('href');
        const text = a.innerText.trim();
        if (href && text) {
            try {
                // Determine if link is internal
                let isInternal = false;
                if (href.startsWith('/') || href.startsWith('#')) {
                    isInternal = true;
                } else {
                    const urlObj = new URL(href, baseDomain ? `https://${baseDomain}` : window.location.origin);
                    const currentHostname = urlObj.hostname.replace('www.', '');
                    if (baseDomain && currentHostname === baseDomain) {
                        isInternal = true;
                    }
                }

                // Double check against inventory paths
                const path = normalizeUrl(href);
                if (inventoryPaths.has(path)) isInternal = true;

                const isExcluded = EXCLUDED_URL_PATTERNS.some(p => href.toLowerCase().includes(p.toLowerCase()));
                
                if (isInternal && !isExcluded) {
                    links.push({ anchor: text, url: href });
                }
            } catch (e) { /* invalid url */ }
        }
    });
    return links.slice(0, 50);
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
    setMainArticleStatus({ message: 'Initializing secure fetch...', type: 'info' });
    try {
      const response = await fetchWithProxyFallbacks(mainArticleUrl);
      const html = await response.text();
      if (!html || html.length < 200) throw new Error("Fetched content is too short. Try pasting the content instead.");
      setMainArticleHtml(html);
      setMainArticleStatus({ message: 'Draft fetched successfully!', type: 'success' });
    } catch (e) {
      setMainArticleStatus({ message: (e as Error).message, type: 'error' });
    } finally { setIsProcessingMain(false); }
  };

  const runFastAnalysis = async () => {
    setIsAnalysisRunning(true);
    setCurrentPhase('Initializing Analysis Engine...');
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    const rawContent = mainArticleInputMode === 'fetch' ? mainArticleHtml : mainArticle;
    const compactContent = toCompactContent(rawContent);
    const baseDomain = getHostname(mainArticleUrl);
    
    // Internal Links Audit
    const existingInternalLinks = extractExistingLinks(rawContent, baseDomain, parsedArticles);
    const existingInternalUrls = existingInternalLinks.map(l => normalizeUrl(l.url));
    
    const targetOutboundCount = Math.min(15, Math.max(3, Math.ceil(compactContent.split(/\s+/).length / 250)));

    try {
        setCurrentPhase('Classifying Content Stage & Entities...');
        const [classTask, paaTask] = await Promise.all([
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Analyze Content Role and Entities:
              ${compactContent}
              
              Task:
              1. Classify the Content Stage strictly as:
                 - Awareness (General info/Problem discovery)
                 - Consideration (Solution comparison/Guides)
                 - Decision (Product pages/Pricing/Demo)
              2. Extract Top 3 Key Entities or Products.
              3. Identify User Intent.
              
              Return JSON: { "primary_topic", "user_intent", "content_stage", "key_entities": [] }`,
              config: { responseMimeType: 'application/json' }
          }),
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Search for top 5 'People Also Ask' questions related to: "${compactContent.substring(0, 500)}".`,
              config: { tools: [{googleSearch: {}}] }
          })
        ]);

        const analysis = extractJson(classTask.text);
        setCurrentAnalysisResult(analysis);
        
        const groundingChunks = (paaTask.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingChunk[]) || [];
        setGroundingLinks(groundingChunks.filter(c => c.web).map(c => ({ title: c.web!.title, uri: c.web!.uri })));
        const paaQuestionsText = paaTask.text;

        setCurrentPhase(`Analyzing Internal Inventory (${parsedArticles.length} pages)...`);
        
        // Dynamic Sampling for Inbound/Outbound
        const sampledInventory = parsedArticles.slice(0, 200).map(p => ({ 
            url: p.url, title: p.title, 
            type: moneyPatterns.some(m => p.url.includes(m)) ? 'MONEY_PAGE' : pillarPatterns.some(pp => p.url.includes(pp)) ? 'STRATEGIC_PILLAR' : 'CONTENT' 
        }));

        const [outboundTask, inboundTask, auditTask] = await Promise.allSettled([
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `INTERNAL LINKING ARCHITECTURE.
                Primary Topic: ${analysis.primary_topic}
                PAA Context: ${paaQuestionsText}
                Draft Content: ${compactContent}
                Existing Internal Links (URLs): ${JSON.stringify(existingInternalUrls)}
                
                Task: Suggest ${targetOutboundCount} NEW internal links from this draft to the provided inventory.
                Inventory Pool: ${JSON.stringify(sampledInventory.slice(0, 50))}
                
                Rules: Use descriptive "Bridge" anchors. If matching a PAA question, cite it.
                Return JSON: { "suggestions": [{ "anchor_text", "target_url", "target_type", "original_paragraph", "paragraph_with_link", "reasoning", "strategy_tag", "is_paa_match", "matched_paa_question" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `INBOUND LINK DISCOVERY.
                Find 5 pages in this inventory that should link TO our current topic: "${analysis.primary_topic}".
                Inventory: ${JSON.stringify(sampledInventory.slice(0, 100))}
                
                Focus: Find existing content that mentions concepts related to "${analysis.primary_topic}" but lacks detail.
                Return JSON: { "suggestions": [{ "source_page_title", "source_page_url", "reasoning", "suggested_anchor_text" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `INTERNAL LINK AUDIT.
                Draft Topic: "${analysis.primary_topic}". 
                Internal links to review: ${JSON.stringify(existingInternalLinks)}.
                
                Task: Audit these links for SEO quality. 
                Ignore any links that are not in the provided list.
                Return JSON: { "audits": [{ "anchor_text", "url", "score", "relevance_score", "anchor_score", "flow_score", "reasoning", "recommendation", "is_duplicate" }] }`,
                config: { responseMimeType: 'application/json' }
            })
        ]);

        if (outboundTask.status === 'fulfilled') {
            const raw = extractJson(outboundTask.value.text).suggestions || [];
            setSuggestions(raw.filter((s: Suggestion) => !existingInternalUrls.includes(normalizeUrl(s.target_url))));
        }
        if (inboundTask.status === 'fulfilled') {
            setInboundSuggestions(extractJson(inboundTask.value.text).suggestions || []);
        }
        if (auditTask.status === 'fulfilled') {
            setExistingAudits(extractJson(auditTask.value.text).audits || []);
        }

        setCurrentPhase('Analysis Complete.');
    } catch (e) {
        console.error(e);
        setCurrentPhase('Analysis failed: ' + (e as Error).message);
    } finally { setIsAnalysisRunning(false); }
  };

  const copyToClipboard = (type: 'markdown' | 'html') => {
      let content = "";
      if (type === 'markdown') {
          content = `# NexusFlow SEO Report: ${currentAnalysisResult?.primary_topic}\n\n`;
          content += `## Analysis Snapshot\n- **Stage:** ${currentAnalysisResult?.content_stage}\n- **Top Entities:** ${currentAnalysisResult?.key_entities?.join(', ')}\n- **Intent:** ${currentAnalysisResult?.user_intent}\n\n`;
          content += `## Outbound Strategic Links\n`;
          suggestions.forEach(s => content += `- **${s.anchor_text}** → ${s.target_url} (${s.strategy_tag})\n`);
          content += `\n## Inbound Strategy\n`;
          inboundSuggestions.forEach(s => content += `- Source: "${s.source_page_title}" (Anchor: "${s.suggested_anchor_text}")\n`);
      } else {
          suggestions.forEach(s => content += `${s.paragraph_with_link}\n\n`);
      }
      navigator.clipboard.writeText(content);
      alert(`${type.toUpperCase()} Report copied!`);
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>NexusFlow AI ⚡</h1>
        <p>User Journey & Search-Grounded Internal Linking</p>
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
            <div style={{display:'flex', justifyContent:'space-between', alignItems:'baseline'}}>
              <h2>1. Source Draft</h2>
              {mainArticleUrl && <span className="badge" style={{background:'var(--secondary-color)', fontSize:'0.6rem'}}>Target Domain: {getHostname(mainArticleUrl)}</span>}
            </div>
            <div className="radio-group" style={{marginBottom: '1rem'}}>
                <label className={mainArticleInputMode === 'fetch' ? 'active' : ''}>
                    <input type="radio" checked={mainArticleInputMode === 'fetch'} onChange={() => setMainArticleInputMode('fetch')} /> 
                    Fetch URL
                </label>
                <label className={mainArticleInputMode === 'paste' ? 'active' : ''} style={{marginLeft:'20px'}}>
                    <input type="radio" checked={mainArticleInputMode === 'paste'} onChange={() => setMainArticleInputMode('paste')} /> 
                    Paste Draft
                </label>
            </div>
            {mainArticleInputMode === 'fetch' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://..." value={mainArticleUrl} onChange={e => setMainArticleUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={handleFetchArticle} disabled={isProcessingMain}>
                        {isProcessingMain ? 'Fetching...' : 'Fetch'}
                    </button>
                </div>
            ) : <textarea className="input" placeholder="Paste HTML or Text draft here..." value={mainArticle} onChange={e => setMainArticle(e.target.value)} />}
            
            {mainArticleStatus.message && <div className={`status-message ${mainArticleStatus.type}`}>{mainArticleStatus.message}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Site Inventory</h2>
            <div className="radio-group" style={{marginBottom: '1.5rem'}}>
                <label><input type="radio" checked={inventoryInputMode === 'sitemap'} onChange={() => setInventoryInputMode('sitemap')} /> Sitemap XML</label>
                <label style={{marginLeft:'20px'}}><input type="radio" checked={inventoryInputMode === 'file'} onChange={() => setInventoryInputMode('file')} /> CSV/XML File</label>
            </div>
            {inventoryInputMode === 'sitemap' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://example.com/sitemap.xml" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
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
                <h2>3. Strategy Map</h2>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px'}}>
                    <div className="review-box" style={{borderLeftColor:'#8b5cf6'}}>
                        <strong>💰 Money Patterns</strong>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'5px'}}>
                            {moneyPatterns.map(p => <span key={p} className="badge badge-money">{p}</span>)}
                        </div>
                    </div>
                    <div className="review-box" style={{borderLeftColor:'#06b6d4'}}>
                        <strong>🏛️ Pillar Patterns</strong>
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
                        <button className="btn btn-primary" style={{padding:'1rem 3rem'}} onClick={runFastAnalysis}>Generate Link Map</button>
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
                                <span className="sd-label">Stage</span>
                                <div className="sd-value" style={{color:'var(--primary-color)'}}>{currentAnalysisResult.content_stage}</div>
                            </div>
                            <div className="sd-card">
                                <span className="sd-label">Intent</span>
                                <div className="sd-value">{currentAnalysisResult.user_intent}</div>
                            </div>
                            <div className="sd-card">
                                <span className="sd-label">Key Entities</span>
                                <div className="sd-value" style={{fontSize:'0.8rem'}}>{currentAnalysisResult.key_entities?.join(', ') || 'N/A'}</div>
                            </div>
                        </div>

                        <div className="tabs-header">
                            <button className={`tab-btn ${activeTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveTab('outbound')}>Strategic Outbound ({suggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveTab('inbound')}>Inbound Sources ({inboundSuggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>Link Audit ({existingAudits.length})</button>
                        </div>

                        {activeTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>{s.anchor_text}</h3>
                                            <span className={`badge ${s.target_type === 'MONEY_PAGE' ? 'badge-money' : s.target_type === 'STRATEGIC_PILLAR' ? 'badge-pillar' : 'new'}`}>{s.target_type}</span>
                                        </div>
                                        <p style={{fontSize:'0.85rem', marginBottom:'10px'}}>Target: <a href={s.target_url} target="_blank">{s.target_url}</a></p>
                                        <div className="suggestion-context">
                                          <strong>Reasoning:</strong> {s.reasoning}<br/>
                                          {s.matched_paa_question && <div style={{marginTop:'5px', color:'var(--success-color)', fontWeight:'bold'}}>Verified: Answers PAA Question - {s.matched_paa_question}</div>}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'inbound' && (
                            <div className="tab-content">
                                {inboundSuggestions.length === 0 ? (
                                    <p style={{textAlign:'center', padding:'2rem', color:'var(--text-muted)'}}>No strong inbound candidates found in inventory. Expand your site map and re-run.</p>
                                ) : inboundSuggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>From: {s.source_page_title}</h3>
                                        </div>
                                        <p style={{fontSize:'0.85rem'}}>Source URL: <a href={s.source_page_url} target="_blank">{s.source_page_url}</a></p>
                                        <div className="suggestion-context">
                                            <strong>Suggested Anchor:</strong> "{s.suggested_anchor_text}"<br/>
                                            <strong>Topical Bridge:</strong> {s.reasoning}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'audit' && (
                            <div className="tab-content">
                                {existingAudits.length === 0 ? (
                                    <p style={{textAlign:'center', padding:'2rem', color:'var(--text-muted)'}}>No existing internal links found in the draft to audit.</p>
                                ) : existingAudits.map((a, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>"{a.anchor_text}"</h3>
                                            <div style={{fontWeight:'bold', color: a.score > 80 ? 'var(--success-color)' : 'var(--error-color)'}}>{a.score}% Quality</div>
                                        </div>
                                        <p style={{fontSize:'0.85rem'}}>Path: {a.url}</p>
                                        <div className="suggestion-context" style={{marginTop:'10px'}}>{a.recommendation}</div>
                                    </div>
                                ))}
                            </div>
                        )}

                        <div style={{display:'flex', gap:'10px', marginTop:'2rem'}}>
                            <button className="btn btn-secondary" onClick={() => copyToClipboard('markdown')}>Copy Full Report</button>
                        </div>
                    </div>
                )}
            </div>
        )}
      </div>

      <div className="navigation-buttons">
            <button className="btn btn-secondary" onClick={() => setStep(s => Math.max(1, s - 1))} disabled={step === 1 || isAnalysisRunning}>Back</button>
            {step < 4 && <button className="btn btn-primary" onClick={() => setStep(s => Math.min(4, s + 1))} disabled={step === 1 ? (!mainArticleHtml && !mainArticle) : step === 2 ? parsedArticles.length === 0 : false}>Next</button>}
      </div>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);