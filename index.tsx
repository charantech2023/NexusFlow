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
    isMoneyPage?: boolean;
    isStrategicPage?: boolean;
}

interface AnalysisConfig {
    outbound: boolean;
    inbound: boolean;
    existing: boolean;
    tone: string;
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
    anchor_type?: string;
    target_url: string;
    target_type: 'MONEY_PAGE' | 'STRATEGIC_PILLAR' | 'STANDARD_CONTENT';
    original_paragraph: string;
    paragraph_with_link: string;
    original_url?: string;
    reasoning: string;
    internal_link_score: number;
    strategy_tag: string;
    isMoneyPage?: boolean;
    isStrategicPage?: boolean;
    placementError?: string;
    is_paa_match?: boolean;
    matched_paa_question?: string;
}

interface ExistingLink {
    anchor_text: string;
    target_url: string;
    score: number;
    relevance_score?: number;
    anchor_score?: number;
    flow_score?: number;
    reasoning: string;
    improvement_suggestion: string;
    is_duplicate: boolean;
}

interface InboundSuggestion {
    source_page_title: string;
    source_page_url: string;
    relevance_score: number;
    reasoning: string;
    suggested_anchor_text: string;
    relationship_type: string;
    placement?: {
        original_paragraph: string;
        new_paragraph_html: string;
    };
    placementError?: string;
}

interface PaaData {
    questions: string[];
    source_urls: { title: string; uri: string }[];
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

const NAV_SELECTORS = [
    'nav', 'header', 'footer', 'aside',
    '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
    '.nav', '.navigation', '.menu', '.sidebar', '.breadcrumbs', '.breadcrumb', '.pagination',
    '.site-header', '.site-footer', '#sidebar', '#menu', '#nav', '.widget-area', '.ad-container',
    '.entry-meta', '.post-meta', '.cat-links', '.tags-links', '.metadata', '.post-info'
].join(', ');

const EXCLUDED_URL_PATTERNS = [
  /\/tag\//, /\/category\//, /\/author\//, /\/page\//, /\/feed\//,
  /privacy-policy/, /terms-of-service/, /disclaimer/, /cookie-policy/,
  /login/, /signup/, /register/, /cart/, /checkout/, /account/,
  /\.(pdf|jpg|jpeg|png|gif|svg|css|js|json|xml|txt)$/i
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
    throw new Error(`Unable to fetch content. This is usually due to CORS restrictions or site blocks. Please use the "Manual Paste" option.`);
};

const normalizeUrl = (urlString: string): string => {
  if (!urlString) return '';
  try {
    const url = new URL(urlString);
    let pathname = url.pathname.toLowerCase();
    if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1);
    return `${url.origin.toLowerCase()}${pathname}`;
  } catch (e) {
    return urlString.toLowerCase().split('?')[0].replace(/\/$/, '');
  }
};

const isSuitableTarget = (url: string) => {
  if (!url) return false;
  const lowerUrl = url.toLowerCase();
  return !EXCLUDED_URL_PATTERNS.some(pattern => pattern.test(lowerUrl));
};

const checkIsMoneyPage = (url: string, patterns: string[]) => {
    const lowerUrl = url.toLowerCase();
    return patterns.some(p => lowerUrl.includes(p.toLowerCase()));
};

const checkIsStrategicPage = (url: string, patterns: string[]) => {
    const lowerUrl = url.toLowerCase();
    return patterns.some(p => lowerUrl.includes(p.toLowerCase()));
};

const extractJson = (text: string) => {
    const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    let jsonText = text.trim();
    if (match && match[1]) jsonText = match[1];
    else {
        const firstBrace = text.indexOf('{');
        const firstBracket = text.indexOf('[');
        if (firstBrace === -1 && firstBracket === -1) throw new Error("No JSON found in response.");
        const startIndex = (firstBrace === -1) ? firstBracket : (firstBracket === -1) ? firstBrace : Math.min(firstBrace, firstBracket);
        const lastBrace = text.lastIndexOf('}');
        const lastBracket = text.lastIndexOf(']');
        const endIndex = Math.max(lastBrace, lastBracket);
        jsonText = text.substring(startIndex, endIndex + 1);
    }
    return JSON.parse(jsonText);
};

const cleanHtmlContent = (html: string) => {
    try {
        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = html;
        const removeSelectors = 'script, style, svg, video, audio, iframe, img, noscript, ' + NAV_SELECTORS;
        tempDiv.querySelectorAll(removeSelectors).forEach(el => el.remove());
        const allElements = tempDiv.querySelectorAll('*');
        allElements.forEach(el => {
            const attributes = Array.from(el.attributes);
            for (const attr of attributes) {
                if (attr.name.toLowerCase() !== 'href') el.removeAttribute(attr.name);
            }
        });
        return tempDiv.innerHTML.substring(0, 30000);
    } catch (e) { return html.substring(0, 20000); }
};

// --- Components ---

const StrategyDashboard = ({ result }: { result: AnalysisResult }) => {
    if (!result) return null;
    let stageColor = '#64748b';
    if (result.content_stage?.toLowerCase().includes('awareness')) stageColor = '#06b6d4';
    if (result.content_stage?.toLowerCase().includes('consideration')) stageColor = '#f59e0b';
    if (result.content_stage?.toLowerCase().includes('decision')) stageColor = '#8b5cf6';

    return (
        <div className="strategy-dashboard">
            <div className="sd-card">
                <span className="sd-label">Detected Topic</span>
                <div className="sd-value">📌 {result.primary_topic}</div>
            </div>
            <div className="sd-card">
                <span className="sd-label">User Intent</span>
                <div className="sd-value">🧭 {result.user_intent}</div>
            </div>
            <div className="sd-card" style={{borderLeft: `4px solid ${stageColor}`}}>
                <span className="sd-label" style={{color: stageColor}}>Content Stage (Funnel)</span>
                <div className="sd-value" style={{color: stageColor}}>📊 {result.content_stage}</div>
            </div>
        </div>
    );
};

const VisualLinkMap = ({ inbound, outbound, existing, mainTitle }: { 
    inbound: InboundSuggestion[], 
    outbound: Suggestion[], 
    existing: ExistingLink[],
    mainTitle: string
}) => {
    const width = 800;
    const height = 600;
    const centerX = width / 2;
    const centerY = height / 2;
    const nodes: any[] = [];
    
    const addNodes = (items: any[], type: string, startAngle: number, endAngle: number, radius: number) => {
        if (items.length === 0) return;
        const step = (endAngle - startAngle) / (items.length + 1);
        items.forEach((item, i) => {
            const angle = startAngle + step * (i + 1);
            nodes.push({ x: centerX + radius * Math.cos(angle), y: centerY + radius * Math.sin(angle), type, data: item });
        });
    };

    addNodes(inbound, 'inbound', Math.PI * 0.75, Math.PI * 2.25, 240);
    addNodes(outbound, 'outbound', -Math.PI * 0.4, Math.PI * 0.4, 240);
    addNodes(existing, 'existing', Math.PI * 0.4, Math.PI * 0.9, 160);

    return (
        <div className="link-graph-container">
            <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`}>
                {nodes.map((node, i) => (
                    <line key={`edge-${i}`} x1={node.type === 'inbound' ? node.x : centerX} y1={node.type === 'inbound' ? node.y : centerY} x2={node.type === 'inbound' ? centerX : node.x} y2={node.type === 'inbound' ? centerY : node.y} stroke={node.type === 'inbound' ? '#f59e0b' : '#10b981'} strokeWidth="2" opacity={0.4} />
                ))}
                {nodes.map((node, i) => {
                    let fill = '#10b981'; // Default content
                    if (node.type === 'inbound') fill = '#f59e0b';
                    else if (node.data.target_type === 'MONEY_PAGE') fill = '#8b5cf6';
                    else if (node.data.target_type === 'STRATEGIC_PILLAR') fill = '#06b6d4';
                    
                    return (
                        <circle key={`node-${i}`} cx={node.x} cy={node.y} r={8} fill={fill} stroke="white" strokeWidth="2" />
                    );
                })}
                <circle cx={centerX} cy={centerY} r={30} fill="#4f46e5" stroke="white" strokeWidth="3" />
                <text x={centerX} y={centerY} dy=".3em" textAnchor="middle" fill="white" fontWeight="bold" fontSize="12">YOU</text>
            </svg>
        </div>
    );
};

// --- Main App ---

const App = () => {
  const [step, setStep] = useState(1);
  const [showDocs, setShowDocs] = useState(false);
  
  // Input states
  const [mainArticleInputMode, setMainArticleInputMode] = useState('fetch');
  const [mainArticle, setMainArticle] = useState('');
  const [mainArticleUrl, setMainArticleUrl] = useState('');
  const [mainArticleHtml, setMainArticleHtml] = useState('');
  const [isProcessingMain, setIsProcessingMain] = useState(false);
  const [mainArticleStatus, setMainArticleStatus] = useState({ message: '', type: '' });
  
  const [existingArticlesInputMode, setExistingArticlesInputMode] = useState('sitemap');
  const [sitemapUrl, setSitemapUrl] = useState('');
  const [parsedArticles, setParsedArticles] = useState<ParsedArticle[]>([]);
  const [existingPagesStatus, setExistingPagesStatus] = useState({ message: '', type: '' });
  const [isProcessingInventory, setIsProcessingInventory] = useState(false);

  const [moneyPagePatterns, setMoneyPagePatterns] = useState<string[]>(DEFAULT_MONEY_PATTERNS);
  const [pillarPagePatterns, setPillarPagePatterns] = useState<string[]>(DEFAULT_PILLAR_PATTERNS);
  const [customMoneyInput, setCustomMoneyInput] = useState('');
  const [customPillarInput, setCustomPillarInput] = useState('');

  const [analysisConfig, setAnalysisConfig] = useState<AnalysisConfig>({ outbound: true, inbound: true, existing: true, tone: 'Natural' });
  const [currentAnalysisResult, setCurrentAnalysisResult] = useState<AnalysisResult | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [inboundSuggestions, setInboundSuggestions] = useState<InboundSuggestion[]>([]);
  const [isAnalysisRunning, setIsAnalysisRunning] = useState(false);
  const [currentPhase, setCurrentPhase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [activeResultTab, setActiveResultTab] = useState<'outbound' | 'inbound' | 'existing' | 'visual'>('outbound');

  const [analyzingPlacementId, setAnalyzingPlacementId] = useState<number | null>(null);
  const [manualPasteIndex, setManualPasteIndex] = useState<number | null>(null);
  const [manualPasteContent, setManualPasteContent] = useState<string>('');

  useEffect(() => {
    const saved = localStorage.getItem(SAVED_ARTICLES_KEY);
    if (saved) {
        try {
            const articles = JSON.parse(saved).filter((a: any) => isSuitableTarget(a.url));
            setParsedArticles(articles);
        } catch(e) { console.error("Cache corrupted", e); }
    }
  }, []);

  const handleFetchArticle = async () => {
    if (!mainArticleUrl) return;
    setIsProcessingMain(true);
    setMainArticleStatus({ message: 'Fetching article...', type: 'info' });
    try {
      const response = await fetchWithProxyFallbacks(mainArticleUrl);
      const html = await response.text();
      setMainArticleHtml(html);
      setMainArticleStatus({ message: 'Article fetched successfully.', type: 'success' });
    } catch (e) {
      setMainArticleStatus({ message: (e as Error).message, type: 'error' });
    } finally { setIsProcessingMain(false); }
  };

  const processInventory = (content: string, type: 'csv' | 'xml') => {
      setExistingPagesStatus({ message: 'Processing inventory...', type: 'info' });
      try {
          const articlesMap = new Map<string, ParsedArticle>();
          if (type === 'xml') {
              const parser = new DOMParser();
              const doc = parser.parseFromString(content, "application/xml");
              
              // More robust extraction using tag name across possible namespaces
              let locElements = Array.from(doc.getElementsByTagName('loc'));
              
              // Regex fallback for stubborn XML or malformed parser results
              if (locElements.length === 0) {
                  const locRegex = /<loc>(.*?)<\/loc>/gi;
                  let match;
                  while ((match = locRegex.exec(content)) !== null) {
                      const loc = match[1].trim();
                      if (loc && isSuitableTarget(loc) && !loc.toLowerCase().endsWith('.xml')) {
                          articlesMap.set(normalizeUrl(loc), { title: '', url: loc, type: 'Blog' });
                      }
                  }
              } else {
                  locElements.forEach(node => {
                      const loc = node.textContent?.trim();
                      if (loc && isSuitableTarget(loc) && !loc.toLowerCase().endsWith('.xml')) {
                        articlesMap.set(normalizeUrl(loc), { title: '', url: loc, type: 'Blog' });
                      }
                  });
              }
          } else {
              // CSV logic - ensure we split properly and handle optional quotes
              const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
              const startIndex = (lines[0].toLowerCase().includes('url')) ? 1 : 0;
              lines.slice(startIndex).forEach(line => {
                  const parts = line.split(',');
                  const url = parts[0]?.replace(/^["']|["']$/g, '').trim();
                  const title = parts[1]?.replace(/^["']|["']$/g, '').trim();
                  if (url && isSuitableTarget(url)) articlesMap.set(normalizeUrl(url), { title: title || '', url, type: 'Blog' });
              });
          }

          const articles = Array.from(articlesMap.values());
          if (articles.length === 0) throw new Error("No valid URLs found in the provided source.");
          setParsedArticles(articles);
          localStorage.setItem(SAVED_ARTICLES_KEY, JSON.stringify(articles));
          setExistingPagesStatus({ message: `Success: Loaded ${articles.length} pages.`, type: 'success' });
      } catch (e) {
          setExistingPagesStatus({ message: `Processing failed: ${(e as Error).message}`, type: 'error' });
      }
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

  // --- AI Workflow ---

  const findPlacementWithContent = async (suggestion: InboundSuggestion, sourceHtml: string): Promise<{original_paragraph: string, new_paragraph_html: string}> => {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const targetUrl = mainArticleUrl || '#';
      const cleanSource = cleanHtmlContent(sourceHtml);
      
      const prompt = `Role: Expert Editor.
Task: Perform a surgical edit to insert a natural internal link to a Target Article.

Target Info:
- Title: ${suggestion.source_page_title}
- Target URL: ${targetUrl}
- Required Anchor: ${suggestion.suggested_anchor_text}

Source Article: 
${cleanSource}

Return JSON: { "original_paragraph": "string", "new_paragraph_html": "string" }`;

      const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { responseMimeType: 'application/json' }
      });
      return extractJson(response.text);
  };

  const handleFindInboundPlacement = async (index: number) => {
      setAnalyzingPlacementId(index);
      const suggestion = inboundSuggestions[index];
      const updated = [...inboundSuggestions];
      try {
          const res = await fetchWithProxyFallbacks(suggestion.source_page_url);
          const html = await res.text();
          const placement = await findPlacementWithContent(suggestion, html);
          updated[index].placement = placement;
          updated[index].placementError = undefined;
      } catch (e) {
          updated[index].placementError = (e as Error).message;
      } finally {
          setInboundSuggestions(updated);
          setAnalyzingPlacementId(null);
      }
  };

  const handleManualPlacementAnalysis = async (index: number) => {
      if (!manualPasteContent.trim()) return;
      setAnalyzingPlacementId(index);
      const updated = [...inboundSuggestions];
      try {
          const placement = await findPlacementWithContent(updated[index], manualPasteContent);
          updated[index].placement = placement;
          updated[index].placementError = undefined;
          setManualPasteIndex(null);
          setManualPasteContent('');
      } catch (e) {
          updated[index].placementError = (e as Error).message;
      } finally {
          setInboundSuggestions(updated);
          setAnalyzingPlacementId(null);
      }
  };

  const processOutboundBatch = async (candidates: ParsedArticle[], content: string, analysis: AnalysisResult, targetCount: number): Promise<Suggestion[]> => {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
      const cleanSource = cleanHtmlContent(content);
      
      const targetsWithMeta = candidates.map(c => {
          let type = 'STANDARD_CONTENT';
          if (checkIsMoneyPage(c.url, moneyPagePatterns)) type = 'MONEY_PAGE';
          else if (checkIsStrategicPage(c.url, pillarPagePatterns)) type = 'STRATEGIC_PILLAR';
          return { url: c.url, title: c.title, type };
      });

      const prompt = `Task: Strategic Internal Linking Architecture.

Source Content Stage: ${analysis.content_stage}
Source Primary Topic: ${analysis.primary_topic}

Target Density: Based on the content length, I need exactly ${targetCount} strategic link suggestions.

Journey Framework (Link Priorities):
1. MONEY_PAGE (Conversion): Prioritize these for logic "Next Step" CTAs if source is Consideration/Decision stage.
2. STRATEGIC_PILLAR (Authority): Prioritize these if the source is Awareness stage to build topical depth.
3. STANDARD_CONTENT (Supporting): Use for deep-dives into specific sub-entities.

CRITICAL INSTRUCTION: You MUST select an EXACT paragraph from the "Main Content" provided below. Do not hallucinate content.

Input Content: 
${cleanSource}

Targets Library: 
${JSON.stringify(targetsWithMeta)}

Output Format: JSON.
{ 
  "suggestions": [{ 
    "anchor_text": "string", 
    "target_url": "string", 
    "target_type": "MONEY_PAGE|STRATEGIC_PILLAR|STANDARD_CONTENT",
    "original_paragraph": "THE EXACT ORIGINAL TEXT OF THE PARAGRAPH YOU CHOSE FROM THE INPUT", 
    "paragraph_with_link": "THE CHOSEN PARAGRAPH WITH <a href='target_url'>anchor_text</a> INSERTED NATURALLY",
    "reasoning": "string",
    "strategy_tag": "string"
  }]
}`;

      const response = await ai.models.generateContent({
          model: 'gemini-3-flash-preview',
          contents: prompt,
          config: { responseMimeType: 'application/json' }
      });
      const json = extractJson(response.text);
      return json.suggestions || [];
  };

  const runAnalysis = async () => {
    setIsAnalysisRunning(true);
    setError(null);
    setCurrentPhase('Analyzing content role in marketing funnel...');
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
    const content = mainArticleInputMode === 'fetch' ? mainArticleHtml : mainArticle;
    const cleanContent = cleanHtmlContent(content);

    // Calculate dynamic suggestion count based on word count
    const wordCount = cleanContent.split(/\s+/).filter(word => word.length > 0).length;
    // Rule: Approx 1 link per 200 words, min 3, max 15
    const targetOutboundCount = Math.min(15, Math.max(3, Math.ceil(wordCount / 200)));

    try {
        const classResponse = await ai.models.generateContent({
            model: 'gemini-3-flash-preview',
            contents: `Identify the content stage (Awareness, Consideration, or Decision) and primary topic.
            Content: ${cleanContent.substring(0, 8000)}`,
            config: { responseMimeType: 'application/json' }
        });
        const analysis = extractJson(classResponse.text);
        setCurrentAnalysisResult(analysis);

        if (analysisConfig.outbound) {
            setCurrentPhase(`Architecting ${targetOutboundCount} strategic outbound journeys...`);
            // Increase search window if we need more links
            const batchSize = Math.max(45, targetOutboundCount * 5);
            const batch = parsedArticles.slice(0, batchSize);
            const res = await processOutboundBatch(batch, content, analysis, targetOutboundCount);
            setSuggestions(res);
        }

        if (analysisConfig.inbound) {
            setCurrentPhase('Mapping inbound backlink opportunities...');
            const inboundPrompt = `Find 5 pages from inventory that should link TO this article about "${analysis.primary_topic}".
            Inventory: ${JSON.stringify(parsedArticles.slice(0, 40).map(p => ({ title: p.title, url: p.url })))}
            Return JSON: { "suggestions": [{ source_page_title, source_page_url, reasoning, suggested_anchor_text }] }`;
            const inboundRes = await ai.models.generateContent({
                model: 'gemini-3-flash-preview',
                contents: inboundPrompt,
                config: { responseMimeType: 'application/json' }
            });
            setInboundSuggestions(extractJson(inboundRes.text).suggestions || []);
        }

        setCurrentPhase('Finalizing reports...');
        setActiveResultTab(analysisConfig.outbound ? 'outbound' : 'inbound');
    } catch (e) {
        setError((e as Error).message);
    } finally { setIsAnalysisRunning(false); }
  };

  return (
    <div className="app-container">
      <header className="header">
        <h1>NexusFlow AI</h1>
        <p>Strategic Internal Link Architecture</p>
      </header>

      <div className="progress-indicator">
        <div className={`pi-step ${step >= 1 ? 'active' : ''}`}>1</div>
        <div className="pi-line" style={{backgroundColor: step >= 2 ? 'var(--primary-color)' : ''}}></div>
        <div className={`pi-step ${step >= 2 ? 'active' : ''}`}>2</div>
        <div className="pi-line" style={{backgroundColor: step >= 3 ? 'var(--primary-color)' : ''}}></div>
        <div className={`pi-step ${step >= 3 ? 'active' : ''}`}>3</div>
        <div className="pi-line" style={{backgroundColor: step >= 4 ? 'var(--primary-color)' : ''}}></div>
        <div className={`pi-step ${step >= 4 ? 'active' : ''}`}>4</div>
      </div>

      <div className="content-body">
        {step === 1 && (
          <div className="wizard-step">
            <h2>1. Source Content</h2>
            <div className="radio-group">
                <label className="radio-group-inline"><input type="radio" checked={mainArticleInputMode === 'fetch'} onChange={() => setMainArticleInputMode('fetch')} /> Fetch URL</label>
                <label className="radio-group-inline"><input type="radio" checked={mainArticleInputMode === 'paste'} onChange={() => setMainArticleInputMode('paste')} /> Paste HTML</label>
            </div>
            {mainArticleInputMode === 'fetch' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://example.com/draft" value={mainArticleUrl} onChange={e => setMainArticleUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={handleFetchArticle} disabled={isProcessingMain}>Fetch</button>
                </div>
            ) : <textarea className="input" placeholder="<html>...</html>" value={mainArticle} onChange={e => setMainArticle(e.target.value)} />}
            {mainArticleStatus.message && <div className={`status-message ${mainArticleStatus.type}`}>{mainArticleStatus.message}</div>}
          </div>
        )}

        {step === 2 && (
          <div className="wizard-step">
            <h2>2. Library Inventory</h2>
            <div className="radio-group">
                <label className="radio-group-inline"><input type="radio" checked={existingArticlesInputMode === 'sitemap'} onChange={() => setExistingArticlesInputMode('sitemap')} /> Sitemap URL</label>
                <label className="radio-group-inline"><input type="radio" checked={existingArticlesInputMode === 'file'} onChange={() => setExistingArticlesInputMode('file')} /> Upload CSV/XML</label>
            </div>
            {existingArticlesInputMode === 'sitemap' ? (
                <div className="input-group">
                    <input type="text" className="input" placeholder="https://example.com/sitemap.xml" value={sitemapUrl} onChange={e => setSitemapUrl(e.target.value)} />
                    <button className="btn btn-primary" onClick={async () => {
                        setIsProcessingInventory(true);
                        try {
                            const res = await fetchWithProxyFallbacks(sitemapUrl);
                            processInventory(await res.text(), 'xml');
                        } catch(e) { setExistingPagesStatus({message: (e as Error).message, type: 'error'}); }
                        finally { setIsProcessingInventory(false); }
                    }} disabled={isProcessingInventory}>Load Sitemap</button>
                </div>
            ) : (
                <div className="input-group">
                    <input type="file" className="input" accept=".csv,.xml" onChange={handleFileUpload} />
                </div>
            )}
            {existingPagesStatus.message && <div className={`status-message ${existingPagesStatus.type}`}>{existingPagesStatus.message}</div>}
            <p style={{fontSize: '0.85rem', color: 'var(--text-muted)'}}>Supported: XML Sitemap URLs, XML Files, and CSV Files (Column 1: URL, Column 2: Title).</p>
          </div>
        )}

        {step === 3 && (
            <div className="wizard-step">
                <h2>3. Journey Mapping Patterns</h2>
                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'2rem'}}>
                    <div className="review-box" style={{borderLeft: '4px solid #8b5cf6'}}>
                        <strong>💰 Money Pages (Conversion)</strong>
                        <div className="input-group" style={{marginTop:'10px'}}>
                            <input type="text" className="input" value={customMoneyInput} onChange={e => setCustomMoneyInput(e.target.value)} placeholder="/product/" />
                            <button className="btn btn-primary" onClick={() => {
                                if (customMoneyInput) setMoneyPagePatterns([...moneyPagePatterns, customMoneyInput]);
                                setCustomMoneyInput('');
                            }}>Add</button>
                        </div>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'8px'}}>
                            {moneyPagePatterns.map(p => <span key={p} className="badge badge-money">{p}</span>)}
                        </div>
                    </div>

                    <div className="review-box" style={{borderLeft: '4px solid #06b6d4'}}>
                        <strong>🏛️ Strategic Pillars (Authority)</strong>
                        <div className="input-group" style={{marginTop:'10px'}}>
                            <input type="text" className="input" value={customPillarInput} onChange={e => setCustomPillarInput(e.target.value)} placeholder="/ultimate-guide/" />
                            <button className="btn btn-primary" onClick={() => {
                                if (customPillarInput) setPillarPagePatterns([...pillarPagePatterns, customPillarInput]);
                                setCustomPillarInput('');
                            }}>Add</button>
                        </div>
                        <div style={{marginTop:'10px', display:'flex', flexWrap:'wrap', gap:'8px'}}>
                            {pillarPagePatterns.map(p => <span key={p} className="badge new" style={{background:'#06b6d4'}}>{p}</span>)}
                        </div>
                    </div>
                </div>
            </div>
        )}

        {step === 4 && (
            <div className="wizard-step">
                {!isAnalysisRunning && suggestions.length === 0 && inboundSuggestions.length === 0 && (
                    <div style={{textAlign:'center', padding:'3rem 0'}}>
                        <button className="btn btn-primary" style={{padding:'1rem 3rem', fontSize:'1.2rem'}} onClick={runAnalysis}>Launch Architecture Analysis</button>
                    </div>
                )}
                {isAnalysisRunning && <div style={{textAlign:'center', padding:'3rem 0'}}><span className="spinner"></span><p style={{marginTop:'1rem'}}>{currentPhase}</p></div>}
                {error && <div className="status-message error">{error}</div>}

                {currentAnalysisResult && !isAnalysisRunning && (
                    <div className="results-container">
                        <StrategyDashboard result={currentAnalysisResult} />
                        <div className="tabs-header">
                            <button className={`tab-btn ${activeResultTab === 'outbound' ? 'active' : ''}`} onClick={() => setActiveResultTab('outbound')}>Outbound Suggestions ({suggestions.length})</button>
                            <button className={`tab-btn ${activeResultTab === 'inbound' ? 'active' : ''}`} onClick={() => setActiveResultTab('inbound')}>Inbound Backlinks ({inboundSuggestions.length})</button>
                            <button className={`tab-btn ${activeResultTab === 'visual' ? 'active' : ''}`} onClick={() => setActiveResultTab('visual')}>Visual Mapping</button>
                        </div>

                        {activeResultTab === 'outbound' && (
                            <div className="tab-content">
                                {suggestions.length === 0 ? <div className="status-message warning">No suitable outbound link opportunities found for the selected targets.</div> : suggestions.map((s, i) => {
                                    const badgeClass = s.target_type === 'MONEY_PAGE' ? 'badge-money' : s.target_type === 'STRATEGIC_PILLAR' ? 'badge-pillar' : 'new';
                                    const badgeLabel = s.target_type === 'MONEY_PAGE' ? 'Money Page' : s.target_type === 'STRATEGIC_PILLAR' ? 'Strategic Pillar' : 'Supporting Content';
                                    
                                    return (
                                        <div key={i} className="suggestion-item">
                                            <div className="suggestion-header">
                                                <h3>{s.anchor_text}</h3>
                                                <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
                                            </div>
                                            <p style={{fontSize:'0.9rem'}}><strong>Target:</strong> <a href={s.target_url} target="_blank">{s.target_url}</a></p>
                                            <p style={{margin:'10px 0'}}><em>Strategy: {s.strategy_tag}</em> — {s.reasoning}</p>
                                            
                                            <div className="placement-view">
                                                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1.5rem', marginTop:'1rem'}}>
                                                    <div>
                                                        <span className="sd-label">Original Content</span>
                                                        <div className="suggestion-context" style={{borderLeftColor:'#e2e8f0'}} dangerouslySetInnerHTML={{__html: s.original_paragraph || 'Text not mapped'}} />
                                                    </div>
                                                    <div>
                                                        <span className="sd-label" style={{color:'var(--success-color)'}}>Optimized with Link</span>
                                                        <div className="suggestion-context" style={{borderLeftColor:'var(--success-color)'}} dangerouslySetInnerHTML={{__html: s.paragraph_with_link}} />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        )}

                        {activeResultTab === 'inbound' && (
                            <div className="tab-content">
                                {inboundSuggestions.map((s, i) => (
                                    <div key={i} className="suggestion-item">
                                        <div className="suggestion-header">
                                            <h3>From: {s.source_page_title}</h3>
                                            <span className="badge new">Backlink</span>
                                        </div>
                                        <p><strong>Source:</strong> <a href={s.source_page_url} target="_blank">{s.source_page_url}</a></p>
                                        <p style={{margin:'10px 0'}}>{s.reasoning}</p>
                                        
                                        {s.placement ? (
                                            <div className="placement-view">
                                                <div style={{display:'grid', gridTemplateColumns:'1fr 1fr', gap:'1.5rem', marginTop:'1rem'}}>
                                                    <div>
                                                        <span className="sd-label">Original Text</span>
                                                        <div className="suggestion-context" style={{borderLeftColor:'#e2e8f0'}} dangerouslySetInnerHTML={{__html: s.placement.original_paragraph}} />
                                                    </div>
                                                    <div>
                                                        <span className="sd-label" style={{color:'var(--success-color)'}}>Surgical Insertion</span>
                                                        <div className="suggestion-context" style={{borderLeftColor:'var(--success-color)'}} dangerouslySetInnerHTML={{__html: s.placement.new_paragraph_html}} />
                                                    </div>
                                                </div>
                                            </div>
                                        ) : manualPasteIndex === i ? (
                                            <div className="manual-paste-box">
                                                <textarea className="input" style={{height:'150px'}} value={manualPasteContent} onChange={e => setManualPasteContent(e.target.value)} placeholder="Paste Source HTML" />
                                                <div style={{marginTop:'10px', display:'flex', gap:'10px'}}>
                                                    <button className="btn btn-primary btn-sm" onClick={() => handleManualPlacementAnalysis(i)}>Analyze Paste</button>
                                                    <button className="btn btn-secondary btn-sm" onClick={() => setManualPasteIndex(null)}>Cancel</button>
                                                </div>
                                            </div>
                                        ) : (
                                            <div className="inbound-actions">
                                                <button className="btn btn-primary btn-sm" onClick={() => handleFindInboundPlacement(i)} disabled={analyzingPlacementId === i}>
                                                    {analyzingPlacementId === i ? 'Scanning...' : 'Find Exact Placement'}
                                                </button>
                                                <button className="btn btn-secondary btn-sm" style={{marginLeft:'10px'}} onClick={() => setManualPasteIndex(i)}>Manual Paste</button>
                                            </div>
                                        )}
                                    </div>
                                ))}
                            </div>
                        )}

                        {activeResultTab === 'visual' && <VisualLinkMap inbound={inboundSuggestions} outbound={suggestions} existing={[]} mainTitle="Current Article" />}
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