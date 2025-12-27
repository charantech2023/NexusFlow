
# NexusFlow AI

An enterprise-grade internal link optimization tool powered by Google Gemini 3 and Firecrawl.

## 🚀 How to Run Locally

1.  **Install Node.js**: Ensure you have Node.js installed on your computer.
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Set Environment Variables**:
    Create a file named `.env` in the root directory and add your API Keys:
    ```
    API_KEY=your_google_gemini_api_key_here
    FIRECRAWL_API_KEY=your_firecrawl_api_key_here
    ```
4.  **Start the App**:
    ```bash
    npm run dev
    ```

## ☁️ How to Secure Keys for GitHub

1.  **NEVER** commit your `.env` file. It is already included in `.gitignore`.
2.  **Deploying to Vercel/Netlify**:
    *   Go to your project dashboard.
    *   Navigate to **Settings** -> **Environment Variables**.
    *   Add `API_KEY` and `FIRECRAWL_API_KEY` with their respective values.
    *   Vite will automatically inject these into the build.

## 🛠️ Tech Stack
*   **AI Model**: Google Gemini 3 Flash
*   **Crawling**: Firecrawl (Map & Scrape API)
*   **Frontend**: React 19 + Vite
