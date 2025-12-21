import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI, Type } from "@google/genai";

// Fix for TypeScript build error: "Cannot find name 'process'"
declare const process: any;

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
    '/author/',
    '/category/',
    '/tag/',
    '/search/',
    '/login',
    '/signup',
    '/register',
    '/privacy-policy',
    '/terms-of-service',
    '/contact',
    '/about',
    '/comments',
    '/feed/',
    'mailto:',
    'tel:',
    'javascript:',
    '#'
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
    throw new Error(`Unable to fetch. Please use "Manual Paste".`);
};

const normalizeUrl = (urlString: string): string => {
  try {
    const url = new URL(urlString, window.location.origin);
    let pathname = url.pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return pathname; // We use pathname for internal comparison
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
            const isExcluded = EXCLUDED_URL_PATTERNS.some(pattern => 
                href.toLowerCase().includes(pattern.toLowerCase())
            );
            if (!isExcluded) {
                links.push({ anchor: text, url: href });
            }
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
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'outbound' | 'inbound' | 'audit'>('outbound');

  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ARTICLES_KEY);
    if (saved) setParsedArticles(JSON.parse(saved));
  }, []);

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

  const processInventory = (content: string, type: 'csv' | 'xml') => {
      setExistingPagesStatus({ message: 'Processing inventory...', type: 'info' });
      try {
          const articles: ParsedArticle[] = [];
          if (type === 'xml') {
              const locRegex = /<loc>(.*?)<\/loc>/gi;
              let match;
              while ((match = locRegex.exec(content)) !== null) {
                  const loc = match[1].trim();
                  if (!loc.includes('.xml') && !loc.includes('/tag/')) {
                      articles.push({ title: '', url: loc, type: 'Blog' });
                  }
              }
          } else {
              const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
              lines.forEach(line => {
                  const parts = line.split(',');
                  const url = parts[0]?.replace(/^["']|["']$/g, '').trim();
                  const title = parts[1]?.replace(/^["']|["']$/g, '').trim();
                  if (url && url.includes('http')) articles.push({ title: title || '', url, type: 'Blog' });
              });
          }
          setParsedArticles(articles);
          localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(articles));
          setExistingPagesStatus({ message: `Success: Loaded ${articles.length} pages.`, type: 'success' });
      } catch (e) { setExistingPagesStatus({ message: 'Failed to parse inventory.', type: 'error' }); }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      const ext = file.name.split('.').pop()?.toLowerCase();
      reader.onload = (evt) => {
          const content = evt.target?.result as string;
          processInventory(content, ext === 'csv' ? 'csv' : 'xml');
      };
      reader.readAsText(file);
  };

  const runFastAnalysis = async () => {
    setIsAnalysisRunning(true);
    setError(null);
    setCurrentPhase('Launching Intelligent Search Pipeline...');
    
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
    const rawContent = mainArticleInputMode === 'fetch' ? mainArticleHtml : mainArticle;
    const compactContent = toCompactContent(rawContent);
    const existingLinks = extractExistingLinks(rawContent);
    const existingUrls = existingLinks.map(l => normalizeUrl(l.url));
    const wordCount = compactContent.split(/\s+/).length;
    const targetOutboundCount = Math.min(15, Math.max(3, Math.ceil(wordCount / 250)));

    try {
        setCurrentPhase('Fetching live PAA questions & classifying content...');
        const [classTask, paaTask] = await Promise.all([
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Analyze Content Role:\n${compactContent.substring(0, 5000)}\nReturn JSON: { "primary_topic", "user_intent", "content_stage": "Awareness|Consideration|Decision", "key_entities": [] }`,
              config: { responseMimeType: 'application/json' }
          }),
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Search for the top 5 'People Also Ask' questions related to: "${compactContent.substring(0, 500)}". List them clearly.`,
              config: { tools: [{googleSearch: {}}] }
          })
        ]);

        const analysis = extractJson(classTask.text);
        setCurrentAnalysisResult(analysis);
        
        const groundingChunks = (paaTask.candidates?.[0]?.groundingMetadata?.groundingChunks as GroundingChunk[]) || [];
        const discoveredLinks = groundingChunks.filter(c => c.web).map(c => ({
            title: c.web!.title,
            uri: c.web!.uri
        }));
        setGroundingLinks(discoveredLinks);
        const paaQuestionsText = paaTask.text;

        setCurrentPhase(`Architecting journeys and auditing ${existingLinks.length} semantic links...`);
        const searchPool = parsedArticles.slice(0, 50).map(p => ({ 
            url: p.url, 
            title: p.title, 
            type: moneyPatterns.some(m => p.url.includes(m)) ? 'MONEY_PAGE' : pillarPatterns.some(pp => p.url.includes(pp)) ? 'STRATEGIC_PILLAR' : 'CONTENT' 
        }));

        const [outboundTask, inboundTask, auditTask] = await Promise.allSettled([
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `Context: Internal Linking Architecture.
                Source Primary Topic: ${analysis.primary_topic}
                PAA Discovery Context: ${paaQuestionsText}
                
                CRITICAL INSTRUCTION: The following URLs are ALREADY LINKED in the article. 
                DO NOT recommend any target_url from this existing list: ${JSON.stringify(existingUrls)}

                Task: Find ${targetOutboundCount} NEW logical link placements from the Inventory.
                Content: ${compactContent}
                Inventory: ${JSON.stringify(searchPool)}
                
                Rules:
                1. Use "Bridge" anchors.
                2. If a target URL answers a specific PAA question from the list above, set "is_paa_match": true and "matched_paa_question": "THE EXACT QUESTION".
                3. If is_paa_match is true, the "reasoning" MUST be: "This link is a Google Verified journey link because it answers the PAA question: '[MATCHED QUESTION]'"
                4. Verify that target_url is NOT in the list of existing links.
                
                Return JSON: { "suggestions": [{ "anchor_text", "target_url", "target_type", "original_paragraph", "paragraph_with_link", "reasoning", "strategy_tag", "is_paa_match", "matched_paa_question" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `Find 5 pages from this inventory that should link TO an article about: "${analysis.primary_topic}".
                Inventory: ${JSON.stringify(parsedArticles.slice(0, 40).map(p => ({ title: p.title, url: p.url })))}
                Return JSON: { "suggestions": [{ "source_page_title", "source_page_url", "reasoning", "suggested_anchor_text" }] }`,
                config: { responseMimeType: 'application/json' }
            }),
            ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: `Audit the following semantic internal links found in the main content area of an article about "${analysis.primary_topic}".
                Existing Links: ${JSON.stringify(existingLinks)}
                Article Content (Summary): ${compactContent.substring(0, 3000)}
                
                Task: Score each link (0-100). Identify duplicates. Provide a specific recommendation for improvement.
                
                Return JSON: { "audits": [{ "anchor_text", "url", "score", "relevance_score", "anchor_score", "flow_score", "reasoning", "recommendation", "is_duplicate" }] }`,
                config: { responseMimeType: 'application/json' }
            })
        ]);

        if (outboundTask.status === 'fulfilled') {
            const rawSuggestions = extractJson(outboundTask.value.text).suggestions || [];
            // Additional client-side safety filter to ensure zero duplicates
            const filteredSuggestions = rawSuggestions.filter((s: Suggestion) => 
                !existingUrls.includes(normalizeUrl(s.target_url))
            );
            setSuggestions(filteredSuggestions);
        }
        if (inboundTask.status === 'fulfilled') setInboundSuggestions(extractJson(inboundTask.value.text).suggestions || []);
        if (auditTask.status === 'fulfilled') setExistingAudits(extractJson(auditTask.value.text).audits || []);

        setCurrentPhase('Analysis Complete.');
    } catch (e) {
        setError("Pipeline error: " + (e as Error).message);
    } finally { setIsAnalysisRunning(false); }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>NexusFlow AI ⚡</h1>
        <p>Enterprise Internal Link Pipeline</p>
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
            {mainArticleStatus.message && <div className={`status-message ${mainArticleStatus.type}`}>{mainArticleStatus.message}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Link Inventory</h2>
            <div className="radio-group" style={{marginBottom: '1.5rem'}}>
                <label><input type="radio" checked={inventoryInputMode === 'sitemap'} onChange={() => setInventoryInputMode('sitemap')} /> Sitemap XML URL</label>
                <label style={{marginLeft:'20px'}}><input type="radio" checked={inventoryInputMode === 'file'} onChange={() => setInventoryInputMode('file')} /> Upload CSV/XML File</label>
            </div>
            
            {inventoryInputMode === 'sitemap' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://example.com/sitemap.xml" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={async () => {
                        setIsProcessingInventory(true);
                        try {
                            const res = await fetchWithProxyFallbacks(sitemapUrl);
                            processInventory(await res.text(), 'xml');
                        } catch(e) { setExistingPagesStatus({message: (e as Error).message, type: 'error'}); }
                        finally { setIsProcessingInventory(false); }
                    }} disabled={isProcessingInventory}>Load</button>
                </div>
            ) : (
                <div className="input-group">
                    <input type="file" className="input" accept=".csv,.xml" onChange={handleFileUpload} />
                </div>
            )}
            
            {existingPagesStatus.message && <div className={`status-message ${existingPagesStatus.type}`}>{existingPagesStatus.message}</div>}
          </div>
        )}

        {step === 3 && (
            <div className="wizard-step">
                <h2>3. Strategic Parameters</h2>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px'}}>
                    <div className="review-box" style={{borderLeftColor:'#8b5cf6'}}>
                        <strong>💰 Money Page Identifiers</strong>
                        <div style={{marginTop:'10px', color:'var(--text-muted)', fontSize:'0.8rem'}}>High-value conversion URL patterns.</div>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'5px'}}>
                            {moneyPatterns.map(p => <span key={p} className="badge badge-money">{p}</span>)}
                        </div>
                    </div>
                    <div className="review-box" style={{borderLeftColor:'#06b6d4'}}>
                        <strong>🏛️ Pillar Hub Identifiers</strong>
                        <div style={{marginTop:'10px', color:'var(--text-muted)', fontSize:'0.8rem'}}>Top-level authority hub URL patterns.</div>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'5px'}}>
                            {pillarPatterns.map(p => <span key={p} className="badge badge-pillar">{p}</span>)}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {step === 4 && (
            <div className="wizard-step">
                {!isAnalysisRunning && suggestions.length === 0 && inboundSuggestions.length === 0 && (
                    <div style={{textAlign:'center', padding:'3rem'}}>
                        <button className="btn btn-primary" style={{padding:'1rem 3rem'}} onClick={runFastAnalysis}>Start Accelerated Analysis</button>
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
                            <div className="sd-card"><span className="sd-label">Topic</span><div className="sd-value">{currentAnalysisResult.primary_topic}</div></div>
                            <div className="sd-card"><span className="sd-label">Intent</span><div className="sd-value">{currentAnalysisResult.user_intent}</div></div>
                            <div className="sd-card"><span className="sd-label">Funnel</span><div className="sd-value" style={{color:'var(--primary-color)'}}>{currentAnalysisResult.content_stage}</div></div>
                        </div>

                        {groundingLinks.length > 0 && (
                          <div className="review-box" style={{marginBottom:'2rem', borderLeftColor:'var(--accent-color)'}}>
                            <span className="sd-label">PAA Grounding Sources</span>
                            <div style={{display:'flex', flexWrap:'wrap', gap:'10px', marginTop:'5px'}}>
                                {groundingLinks.map((link, idx) => (
                                  <a key={idx} href={link.uri} target="_blank" className="badge" style={{background:'var(--accent-color)', textDecoration:'none', fontSize:'0.7rem'}}>
                                    {link.title}
                                  </a>
                                ))}
                            </div>
                          </div>
                        )}

                        <div className="tabs-header">
                            <button className={`tab-btn ${activeTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveTab('outbound')}>Outbound Suggestions ({suggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveTab('inbound')}>Inbound Backlinks ({inboundSuggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>Existing Link Audit ({existingAudits.length})</button>
                        </div>

                        {activeTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.length === 0 ? <p className="status-message info">No new outbound suggestions found. (Duplicates filtered)</p> : suggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
                                              <h3>{s.anchor_text}</h3>
                                              {s.is_paa_match && <span className="badge" style={{background:'var(--success-color)'}}>Google Verified</span>}
                                            </div>
                                            <span className={`badge ${s.target_type === 'MONEY_PAGE' ? 'badge-money' : s.target_type === 'STRATEGIC_PILLAR' ? 'badge-pillar' : 'new'}`}>{s.target_type}</span>
                                        </div>
                                        <p style={{fontSize:'0.85rem'}}>Target: <a href={s.target_url} target="_blank">{s.target_url}</a></p>
                                        <p style={{margin:'10px 0', fontSize:'0.9rem', color:'var(--text-muted)'}}>{s.reasoning}</p>
                                        <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px', marginTop:'1rem'}}>
                                            <div className="suggestion-context" dangerouslySetInnerHTML={{__html: s.original_paragraph}} />
                                            <div className="suggestion-context" style={{borderLeftColor:'var(--success-color)'}} dangerouslySetInnerHTML={{__html: s.paragraph_with_link}} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                        
                        {activeTab === 'inbound' && (
                            <div className="tab-content">
                                {inboundSuggestions.length === 0 ? <p className="status-message info">No inbound suggestions found.</p> : inboundSuggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header"><h3>From: {s.source_page_title}</h3></div>
                                        <p style={{fontSize:'0.85rem'}}>Source: <a href={s.source_page_url} target="_blank">{s.source_page_url}</a></p>
                                        <p style={{margin:'10px 0'}}><em>Reasoning:</em> {s.reasoning}</p>
                                        <div className="suggestion-context" style={{borderLeftColor:'var(--warning-color)'}}>
                                            Suggested Anchor: <strong>{s.suggested_anchor_text}</strong>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'audit' && (
                            <div className="tab-content">
                                {existingAudits.length === 0 ? (
                                    <p className="status-message info">No relevant internal links found in the main content area for auditing.</p>
                                ) : existingAudits.map((a, i) => {
                                    let scoreColor = 'var(--success-color)';
                                    if (a.score < 50) scoreColor = 'var(--error-color)';
                                    else if (a.score < 80) scoreColor = 'var(--warning-color)';
                                    
                                    return (
                                        <div key={i} className="suggestion-item">
                                            <div className="suggestion-header">
                                                <h3>"{a.anchor_text}"</h3>
                                                <div style={{textAlign:'right'}}>
                                                    <div style={{fontSize:'1.5rem', fontWeight:'bold', color: scoreColor}}>{a.score}</div>
                                                    <div style={{fontSize:'0.7rem', color:'var(--text-muted)'}}>Health Score</div>
                                                </div>
                                            </div>
                                            <p style={{fontSize:'0.85rem'}}><strong>URL:</strong> <a href={a.url} target="_blank">{a.url}</a></p>
                                            
                                            <div style={{display:'grid', gridTemplateColumns:'repeat(3, 1fr)', gap:'10px', margin:'1rem 0'}}>
                                                <div style={{textAlign:'center', padding:'10px', background:'#f1f5f9', borderRadius:'8px'}}>
                                                    <div style={{fontSize:'0.65rem', color:'var(--text-muted)'}}>RELEVANCE</div>
                                                    <div style={{fontWeight:'bold'}}>{a.relevance_score}%</div>
                                                </div>
                                                <div style={{textAlign:'center', padding:'10px', background:'#f1f5f9', borderRadius:'8px'}}>
                                                    <div style={{fontSize:'0.65rem', color:'var(--text-muted)'}}>ANCHOR</div>
                                                    <div style={{fontWeight:'bold'}}>{a.anchor_score}%</div>
                                                </div>
                                                <div style={{textAlign:'center', padding:'10px', background:'#f1f5f9', borderRadius:'8px'}}>
                                                    <div style={{fontSize:'0.65rem', color:'var(--text-muted)'}}>FLOW</div>
                                                    <div style={{fontWeight:'bold'}}>{a.flow_score}%</div>
                                                </div>
                                            </div>

                                            <div style={{margin:'10px 0', fontSize:'0.9rem'}}>
                                                <strong>Analysis:</strong> {a.reasoning}
                                            </div>
                                            
                                            <div className="suggestion-context" style={{borderLeftColor: a.score < 80 ? 'var(--warning-color)' : 'var(--success-color)'}}>
                                                <strong>Recommendation:</strong> {a.recommendation}
                                                {a.is_duplicate && <div style={{marginTop:'5px', color:'var(--error-color)', fontWeight:'bold'}}>⚠️ Duplicate Link Detected</div>}
                                            </div>
                                        </div>
                                    );
                                })}
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