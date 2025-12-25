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
    topology_role: 'HUB' | 'AUTHORITY' | 'CENTER';
}

interface Suggestion {
    suggestion_type: 'NEW' | 'REPLACEMENT';
    anchor_text: string;
    original_anchor?: string;
    target_url: string;
    target_type: 'MONEY_PAGE' | 'STRATEGIC_PILLAR' | 'STANDARD_CONTENT';
    original_paragraph: string;
    paragraph_with_link: string;
    reasoning: string;
    strategy_tag: string;
    information_gain_score: number; 
    surfer_score: number;           
    thematic_alignment: number;      
    connectivity_efficiency: number; 
    target_role: 'HUB' | 'AUTHORITY' | 'CENTER';
    nexus_score: number; 
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
            const id = setTimeout(() => controller.abort(), 12000); 
            const response = await fetch(proxy(url), { method: 'GET', signal: controller.signal });
            clearTimeout(id);
            if (response.ok) return response;
        } catch (e) { lastError = e; }
    }
    throw new Error(lastError ? `CORS/Proxy Error. Try "Paste HTML" mode instead.` : "Fetch failed.");
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
        if (start === -1 || end === -1) {
            const arrStart = jsonText.indexOf('[');
            const arrEnd = jsonText.lastIndexOf(']');
            if (arrStart !== -1 && arrEnd !== -1) return JSON.parse(jsonText.substring(arrStart, arrEnd + 1));
            throw new Error("Invalid JSON structure");
        }
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

// --- Components ---

const NexusBadge = ({ score }: { score: number }) => {
    let color = 'var(--error-color)';
    if (score > 70) color = 'var(--success-color)';
    else if (score > 40) color = 'var(--warning-color)';
    
    return (
        <div className="nexus-score-circle" style={{ borderColor: color }}>
            <span style={{ color }}>{Math.round(score)}</span>
            <small>NEXUS</small>
        </div>
    );
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
  const [expandedSuggestion, setExpandedSuggestion] = useState<number | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ARTICLES_KEY);
    if (saved) setInventory(JSON.parse(saved));
  }, []);

  const handleFetchDraft = async () => {
    if (!draftUrl) return;
    setIsProcessingSource(true);
    setSourceStatus({ message: 'Initializing scrub...', type: 'info' });
    try {
      const res = await fetchWithProxyFallbacks(draftUrl);
      const html = await res.text();
      setDraftHtml(html);
      setSourceStatus({ message: 'Source fetched successfully.', type: 'success' });
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
        for (const sub of subSitemaps.slice(0, 10)) {
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
        alert(`Discovered ${items.length} nodes.`);
    } catch (e) { alert("Sitemap scan failed. Try CSV upload."); }
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
        const title = parts[1]?.trim() || url?.split('/').filter(Boolean).pop()?.replace(/-/g, ' ') || url;
        return { url, title, type: 'CONTENT' };
      }).filter(item => item.url && item.url.startsWith('http'));
      
      setInventory(newItems);
      localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(newItems));
      setIsProcessingInv(false);
      alert(`Imported ${newItems.length} nodes.`);
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
            contents: `Analyze Content Archetype:
            CONTENT:
            ${md}
            JSON Format: { "primary_topic", "user_intent", "content_stage", "key_entities": [], "topology_role": "HUB" | "AUTHORITY" | "CENTER" }`,
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
            contents: `Strategic Internal Link Mapping Task:
            SOURCE_ROLE: ${res1.topology_role}
            INVENTORY: ${JSON.stringify(sampledInventory)}
            CONTENT: ${md}

            Patent Heuristics:
            1. Info Gain: Destination must provide new knowledge delta.
            2. Reasonable Surfer: Body links > generic links.
            3. Flow: Connect to relevant Authorities.

            STRICT: Use VERBATIM substrings from CONTENT.
            JSON Format: { "suggestions": [{ "suggestion_type", "anchor_text", "target_url", "target_type", "target_role", "original_paragraph", "paragraph_with_link", "reasoning", "information_gain_score", "surfer_score", "thematic_alignment", "connectivity_efficiency" }] }`,
            config: { responseMimeType: 'application/json' }
        });
        const res2 = extractJson(task2.text);
        
        const validated = (res2.suggestions || []).filter((s: Suggestion) => {
            const exists = md.includes(s.anchor_text);
            const isFresh = !internalUrls.includes(normalizeUrl(s.target_url));
            return exists && (s.suggestion_type === 'REPLACEMENT' || isFresh);
        }).map((s: Suggestion) => {
            s.nexus_score = (s.information_gain_score * 0.3) + (s.surfer_score * 0.3) + (s.thematic_alignment * 0.2) + (s.connectivity_efficiency * 0.2);
            return s;
        });
        
        setSuggestions(validated.sort((a, b) => b.nexus_score - a.nexus_score));

        const [auditTask, inboundTask] = await Promise.all([
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Audit existing links: ${JSON.stringify(internalLinks)}. JSON Format: { "audits": [{ "anchor_text", "url", "score", "reasoning", "recommendation" }] }`,
              config: { responseMimeType: 'application/json' }
          }),
          ai.models.generateContent({
              model: 'gemini-3-flash-preview',
              contents: `Suggest inbound hubs for topic "${res1.primary_topic}". JSON Format: { "suggestions": [{ "source_page_title", "source_page_url", "reasoning", "suggested_anchor_text" }] }`,
              config: { responseMimeType: 'application/json' }
          })
        ]);
        setAudit(extractJson(auditTask.text).audits || []);
        setInbound(extractJson(inboundTask.text).suggestions || []);
    } catch (e) {
        alert("Strategic analysis failed. Ensure API_KEY is valid.");
    } finally { setIsAnalysing(false); }
  };

  const getImpactLabel = (score: number) => {
      if (score > 85) return { text: 'CRITICAL BRIDGE', color: 'var(--error-color)' };
      if (score > 65) return { text: 'STRATEGIC FLOW', color: 'var(--success-color)' };
      return { text: 'CONTEXTUAL ADD', color: 'var(--primary-color)' };
  };

  return (
    <div className="app-container">
      <header className="header">
        <div style={{display:'flex', alignItems:'center', justifyContent:'center', gap:'15px'}}>
            <h1>NexusFlow AI</h1>
            <div className="live-badge">SYSTEM READY</div>
        </div>
        <p>Architecting Site Authority via Patent-Aligned Topology</p>
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
            <h2>1. Select Source Content</h2>
            <div className="radio-group" style={{marginBottom: '1rem', display:'flex', gap:'20px'}}>
                <label className={inputMode === 'fetch' ? 'active-radio' : ''}>
                    <input type="radio" checked={inputMode === 'fetch'} onChange={() => setInputMode('fetch')} /> Fetch URL
                </label>
                <label className={inputMode === 'paste' ? 'active-radio' : ''}>
                    <input type="radio" checked={inputMode === 'paste'} onChange={() => setInputMode('paste')} /> Paste HTML
                </label>
            </div>
            {inputMode === 'fetch' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://example.com/blog/article" value={draftUrl} onChange={e => setDraftUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={handleFetchDraft} disabled={isProcessingSource}>Scrub</button>
                </div>
            ) : <textarea className="input" placeholder="Paste your draft HTML here..." value={draftInput} onChange={e => setDraftInput(e.target.value)} />}
            {sourceStatus.message && <div className={`status-message ${sourceStatus.type}`}>{sourceStatus.message}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Target Page Inventory</h2>
            <div className="inventory-grid" style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'20px'}}>
                <div className="inv-method">
                    <label style={{display:'block', marginBottom:'10px', fontWeight:800, fontSize:'0.75rem', color:'var(--text-muted)'}}>AUTOMATED SCAN</label>
                    <div className="input-group" style={{flexDirection:'column'}}>
                        <input type="text" className="input" placeholder="sitemap.xml" value={inventoryUrl} onChange={e => setInventoryUrl(e.target.value)} />
                        <button className="btn btn-secondary" style={{marginTop:'5px', width:'100%'}} onClick={handleFetchInventory} disabled={isProcessingInv}>Recurse Sitemap</button>
                    </div>
                </div>
                <div className="inv-method">
                    <label style={{display:'block', marginBottom:'10px', fontWeight:800, fontSize:'0.75rem', color:'var(--text-muted)'}}>MANUAL IMPORT</label>
                    <div className="csv-upload-box" onClick={() => fileInputRef.current?.click()}>
                        <span>{isProcessingInv ? 'Reading...' : 'Drop Article CSV'}</span>
                        <input type="file" ref={fileInputRef} hidden accept=".csv" onChange={handleCsvUpload} />
                    </div>
                </div>
            </div>
            <p style={{textAlign:'center', marginTop:'1.5rem', fontSize:'0.85rem', color:'var(--text-muted)'}}>
                Currently mapping: <strong>{inventory.length}</strong> possible destinations.
            </p>
          </div>
        )}

        {step === 3 && (
            <div className="wizard-step">
                <h2>3. Strategy Alignment</h2>
                <div className="review-box" style={{background:'#f8fafc', padding:'2rem', borderRadius:'20px', border:'2px dashed var(--border-color)'}}>
                    <p style={{marginBottom:'1rem', fontWeight:600}}>AI will process using the following logic:</p>
                    <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'10px'}}>
                        <div className="settings-pill">2D Topology Check: ON</div>
                        <div className="settings-pill">Info Gain Delta: ON</div>
                        <div className="settings-pill">Verbatim Anchors: ON</div>
                        <div className="settings-pill">Reasonable Surfer: ON</div>
                    </div>
                    <p style={{marginTop:'1.5rem', fontSize:'0.8rem', opacity:0.7}}>This ensures links are mathematically efficient for both users and search crawlers.</p>
                </div>
            </div>
        )}

        {step === 4 && (
            <div className="wizard-step">
                {!isAnalysing && suggestions.length === 0 && (
                    <div style={{textAlign:'center', padding:'3rem'}}>
                        <button className="btn btn-primary btn-lg" onClick={runAnalysis}>Run Architecture Audit</button>
                    </div>
                )}
                {isAnalysing && <div style={{textAlign:'center', padding:'3rem'}}><span className="spinner"></span><p>Calculating Knowledge Deltas...</p></div>}

                {analysis && !isAnalysing && (
                    <div className="results-container">
                        <div className="strategy-dashboard">
                            <div className="sd-card"><span className="sd-label">Stage</span><div className="sd-value">{analysis.content_stage}</div></div>
                            <div className="sd-card"><span className="sd-label">Role</span><div className="sd-value">{analysis.topology_role}</div></div>
                            <div className="sd-card"><span className="sd-label">Primary Topic</span><div className="sd-value">{analysis.primary_topic}</div></div>
                        </div>

                        <div className="tabs-header">
                            <button className={`tab-btn ${activeTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveTab('outbound')}>Outbound Bridges ({suggestions.length})</button>
                            <button className={`tab-btn ${activeTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveTab('inbound')}>Inbound Sources ({inbound.length})</button>
                            <button className={`tab-btn ${activeTab === 'audit' ? 'active' : ''}`} onClick={() => setActiveTab('audit')}>Existing Link Audit ({audit.length})</button>
                        </div>

                        {activeTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.map((s, i) => {
                                    const impact = getImpactLabel(s.nexus_score);
                                    return (
                                        <div key={i} className="nexus-card">
                                            <div className="nexus-card-left">
                                                <NexusBadge score={s.nexus_score} />
                                            </div>
                                            <div className="nexus-card-main">
                                                <div className="nexus-card-header">
                                                    <div style={{display:'flex', alignItems:'center', gap:'10px'}}>
                                                        <span className="impact-label" style={{color: impact.color, borderColor: impact.color}}>{impact.text}</span>
                                                        <h3 className="anchor-title">"{s.anchor_text}"</h3>
                                                    </div>
                                                    <span className={`badge ${s.target_type === 'MONEY_PAGE' ? 'badge-money' : 'badge-pillar'}`}>{s.target_type.replace('_', ' ')}</span>
                                                </div>
                                                
                                                <div className="nexus-card-body">
                                                    <div className="nexus-context">
                                                        <span dangerouslySetInnerHTML={{__html: s.paragraph_with_link}} />
                                                    </div>
                                                    <div className="nexus-reason"><strong>Logic:</strong> {s.reasoning}</div>
                                                    
                                                    <div className="expert-toggle" onClick={() => setExpandedSuggestion(expandedSuggestion === i ? null : i)}>
                                                        {expandedSuggestion === i ? '− Hide Heuristics' : '+ View Patent Heuristics'}
                                                    </div>

                                                    {expandedSuggestion === i && (
                                                        <div className="patent-metrics-simple">
                                                            <div className="p-metric"><span>Info Gain</span><div className="p-bar"><div className="p-fill" style={{width: `${s.information_gain_score}%`, background: 'var(--accent-color)'}}></div></div></div>
                                                            <div className="p-metric"><span>Surfer</span><div className="p-bar"><div className="p-fill" style={{width: `${s.surfer_score}%`, background: 'var(--success-color)'}}></div></div></div>
                                                            <div className="p-metric"><span>Thematic</span><div className="p-bar"><div className="p-fill" style={{width: `${s.thematic_alignment}%`, background: 'var(--primary-color)'}}></div></div></div>
                                                            <div className="p-metric"><span>Flow</span><div className="p-bar"><div className="p-fill" style={{width: `${s.connectivity_efficiency}%`, background: 'var(--warning-color)'}}></div></div></div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="nexus-card-footer">
                                                    <span className="target-url-preview">{s.target_url}</span>
                                                    <button className="btn-copy" onClick={() => {
                                                        navigator.clipboard.writeText(s.paragraph_with_link.replace(/<\/?[^>]+(>|$)/g, ""));
                                                        alert('Copied HTML to clipboard');
                                                    }}>Copy HTML</button>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {activeTab === 'inbound' && (
                            <div className="tab-content">
                                {inbound.map((s, i) => (
                                    <div key={i} className="nexus-card">
                                        <div className="nexus-card-main">
                                            <div className="nexus-card-header">
                                                <h3 className="anchor-title">{s.source_page_title}</h3>
                                                <span className="badge badge-pillar">HUB SOURCE</span>
                                            </div>
                                            <div className="nexus-context">
                                                Use Anchor: <strong>"{s.suggested_anchor_text}"</strong>
                                            </div>
                                            <div className="nexus-reason">{s.reasoning}</div>
                                            <div className="nexus-card-footer">
                                                <span className="target-url-preview">{s.source_page_url}</span>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeTab === 'audit' && (
                            <div className="tab-content">
                                {audit.map((a, i) => (
                                    <div key={i} className="nexus-card">
                                        <div className="nexus-card-left">
                                            <NexusBadge score={a.score} />
                                        </div>
                                        <div className="nexus-card-main">
                                            <div className="nexus-card-header">
                                                <h3 className="anchor-title">"{a.anchor_text}"</h3>
                                            </div>
                                            <div className="nexus-reason">{a.reasoning}</div>
                                            <div className="nexus-context"><strong>Recommendation:</strong> {a.recommendation}</div>
                                            <div className="nexus-card-footer">
                                                <span className="target-url-preview">{a.url}</span>
                                            </div>
                                        </div>
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