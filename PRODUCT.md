# NexusFlow AI - Product Documentation

## 1. Overview
**NexusFlow AI** is an enterprise-grade internal link architecture platform. Unlike basic tools that match keywords, NexusFlow uses a **User Journey Framework** and **Google Search Grounding** to validate connections. It ensures every link moves the user down the funnel (Awareness → Consideration → Decision).

## 2. Key Features

### 🧠 Intelligent Content Analysis (PAA Integration)
*   **Search Grounding (The Secret Weapon):** The tool performs a live Google Search for your topic to extract "People Also Ask" (PAA) questions.
*   **Verified Journey Links:** If a target page answers a specific PAA question, it is flagged as a **"Google Verified"** opportunity. This aligns your site structure with proven user demand.
*   **Content Stage Detection:** Automatically classifies your content as **Awareness**, **Consideration**, or **Decision** to guide linking strategy.

### 💰 Smart Money & Strategic Page Strategy
*   **Money Pages (Demand Gen):** High-value conversion pages (e.g., `/product/`) are highlighted with a 🟣 Purple badge. The AI prioritizes driving traffic *to* these pages.
*   **Strategic Content (Authority):** Pillar pages or hubs (e.g., `/guide/`) are highlighted with a 🔵 Blue badge. The AI prioritizes linking these as authority signals.

### 🛡️ Existing Link Audit
*   **Multi-Factor Scoring:** Rates every link (0-100) based on:
    *   **Relevance:** Contextual fit.
    *   **Anchor Quality:** Descriptive vs. generic.
    *   **Flow:** Natural reading experience.
*   **Duplicate Detection:** Flags redundant links to prevent over-optimization.

### 📊 Strategy Dashboard
*   Located at the top of your results, this dashboard gives you an instant snapshot of:
    *   **Primary Topic**
    *   **User Intent** (Informational vs. Transactional)
    *   **Funnel Stage** (Where this content fits in the buyer's journey)

## 3. User Guide

1.  **Step 1: Content Input**
    *   Fetch a live URL or paste your draft HTML. NexusFlow cleans the content (removing navs/footers) for pure analysis.

2.  **Step 2: Inventory**
    *   Upload your Sitemap XML or a CSV. This is the "library" NexusFlow searches through.

3.  **Step 3: Strategy**
    *   Define your **Money Pages** (e.g., matching `/pricing/`) to tell the AI what matters most.

4.  **Step 4: Analyze**
    *   NexusFlow builds a semantic map, checks Google PAA, and scores opportunities.

5.  **Step 5: Results & Export**
    *   Review the **Visual Map** to see your hub-and-spoke structure.
    *   Use **Copy Markdown Report** to paste a summary into Notion/Slack/Jira.
    *   Use **Copy HTML** to get the code ready for CMS insertion.

## 4. Technical Architecture
*   **Frontend:** React 19
*   **AI Model:** Google Gemini 2.5 Flash via `@google/genai`
*   **Grounding:** Google Search Tool for PAA extraction.
