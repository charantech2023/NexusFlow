# NexusFlow AI

An enterprise-grade internal link optimization tool powered by Google Gemini 2.5 Flash.

## 🚀 How to Run Locally

1.  **Install Node.js**: Ensure you have Node.js installed on your computer.
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Set Environment Variable**:
    Create a file named `.env` in the root directory and add your Google Gemini API Key:
    ```
    API_KEY=your_google_api_key_here
    ```
4.  **Start the App**:
    ```bash
    npm run dev
    ```

## ☁️ How to Deploy (Vercel/Netlify)

1.  Push this folder to a **GitHub Repository**.
2.  Connect the repository to **Vercel** or **Netlify**.
3.  In the deployment settings, look for "Environment Variables".
4.  Add a variable named `API_KEY` with your actual Google Gemini API key.
5.  Deploy!

## ⚠️ Note on Streamlit
This is a **React Application**. It cannot be deployed to Streamlit Community Cloud (which supports Python). Use Vercel, Netlify, or GitHub Pages instead.
