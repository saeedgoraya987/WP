const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const axios = require('axios');
const express = require('express');
const cron = require('node-cron');
require('dotenv').config();

// Add stealth plugin
puppeteer.use(StealthPlugin());

// Configuration
const config = {
    captchaApiKey: process.env.CAPTCHA_API_KEY,
    loginUrl: process.env.LOGIN_URL || "https://www.ivasms.com/login",
    email: process.env.EMAIL,
    password: process.env.PASSWORD,
    port: process.env.PORT || 3000,
    headless: process.env.HEADLESS !== 'false',
    cloudflareTimeout: parseInt(process.env.CLOUDFLARE_TIMEOUT) || 60000, // Increased to 60s
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3
};

console.log("[CONFIG] Loaded configuration:");
console.log(`  CAPTCHA_API_KEY: ${config.captchaApiKey ? '✅ Set' : '❌ Missing'}`);
console.log(`  EMAIL: ${config.email ? '✅ Set' : '❌ Missing'}`);
console.log(`  PASSWORD: ${config.password ? '✅ Set' : '❌ Missing'}`);
console.log(`  HEADLESS: ${config.headless}`);
console.log(`  CLOUDFLARE_TIMEOUT: ${config.cloudflareTimeout}ms`);

// 2captcha solver
class CaptchaSolver {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = "https://api.2captcha.com";
    }

    async solveTurnstile(websiteUrl, sitekey) {
        console.log(`[CAPTCHA] Solving Turnstile for: ${websiteUrl}`);
        console.log(`[CAPTCHA] Sitekey: ${sitekey}`);

        const createTaskPayload = {
            clientKey: this.apiKey,
            task: {
                type: "TurnstileTaskProxyless",
                websiteURL: websiteUrl,
                websiteKey: sitekey
            }
        };

        try {
            const createResponse = await axios.post(`${this.baseUrl}/createTask`, createTaskPayload);
            const createResult = createResponse.data;

            if (createResult.errorId !== 0) {
                throw new Error(`Error creating task: ${createResult.errorDescription}`);
            }

            const taskId = createResult.taskId;
            console.log(`[CAPTCHA] Task created: ${taskId}`);

            let attempts = 0;
            const maxAttempts = 30;

            while (attempts < maxAttempts) {
                attempts++;
                console.log(`[CAPTCHA] Waiting for result... (${attempts}/${maxAttempts})`);
                await this.sleep(3000);

                const getResultPayload = {
                    clientKey: this.apiKey,
                    taskId: taskId
                };

                const getResponse = await axios.post(`${this.baseUrl}/getTaskResult`, getResultPayload);
                const result = getResponse.data;

                if (result.errorId !== 0) {
                    throw new Error(`Error getting result: ${result.errorDescription}`);
                }

                if (result.status === "ready") {
                    console.log("[CAPTCHA] ✅ Solved successfully!");
                    return result.solution;
                }
            }

            throw new Error("Timeout waiting for captcha solution");
        } catch (error) {
            console.error(`[CAPTCHA] Error: ${error.message}`);
            throw error;
        }
    }

    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Browser session manager
class BrowserSession {
    constructor() {
        this.browser = null;
        this.page = null;
        this.cookies = [];
        this.isLoggedIn = false;
        this.lastLoginAttempt = null;
    }

    async init() {
        console.log("[BROWSER] Launching browser...");
        
        let launchOptions = {
            headless: config.headless ? "new" : false,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-blink-features=AutomationControlled',
                '--disable-web-security',
                '--disable-features=IsolateOrigins,site-per-process',
                '--window-size=1280,720',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--no-first-run',
                '--no-zygote',
                '--single-process',
                '--disable-extensions',
                '--disable-component-extensions-with-background-pages',
                '--disable-default-apps',
                '--mute-audio',
                '--no-default-browser-check',
                '--autoplay-policy=user-gesture-required',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-breakpad',
                '--disable-client-side-phishing-detection',
                '--disable-crash-reporter',
                '--disable-dev-shm-usage',
                '--disable-domain-reliability',
                '--disable-ipc-flooding-protection',
                '--disable-popup-blocking',
                '--disable-prompt-on-repost',
                '--disable-renderer-backgrounding',
                '--disable-sync',
                '--force-color-profile=srgb',
                '--metrics-recording-only',
                '--safebrowsing-disable-auto-update',
                '--password-store=basic',
                '--use-mock-keychain'
            ]
        };

        // Try to use @sparticuz/chromium for Railway
        try {
            const chromium = require('@sparticuz/chromium');
            const executablePath = await chromium.executablePath();
            if (executablePath) {
                launchOptions.executablePath = executablePath;
                console.log("[BROWSER] ✅ Using @sparticuz/chromium (Railway optimized)");
            }
        } catch (e) {
            console.log("[BROWSER] ℹ️ @sparticuz/chromium not found, using default Chromium");
        }

        try {
            this.browser = await puppeteer.launch(launchOptions);
        } catch (error) {
            console.log("[BROWSER] ❌ Failed to launch with puppeteer-extra, trying fallback...");
            const puppeteerCore = require('puppeteer-core');
            this.browser = await puppeteerCore.launch(launchOptions);
        }

        this.page = await this.browser.newPage();
        
        await this.page.setViewport({ width: 1280, height: 720 });
        await this.page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await this.page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1'
        });

        console.log("[BROWSER] ✅ Browser launched successfully!");
        return this;
    }

    async handleCloudflare() {
        console.log("[BROWSER] ⚠️ Cloudflare challenge detected! Waiting...");
        
        // Wait for Cloudflare to pass with multiple checks
        const startTime = Date.now();
        const maxWait = config.cloudflareTimeout;
        
        while (Date.now() - startTime < maxWait) {
            const title = await this.page.title();
            console.log(`[BROWSER] Current title: "${title}"`);
            
            // Check if we're no longer on the challenge page
            if (!title.includes('Just a moment') && !title.includes('cf-challenge')) {
                console.log("[BROWSER] ✅ Cloudflare bypassed!");
                return true;
            }
            
            // Check for the presence of login form
            const hasForm = await this.page.evaluate(() => {
                return document.querySelector('form') !== null;
            });
            
            if (hasForm) {
                console.log("[BROWSER] ✅ Login form detected - Cloudflare passed!");
                return true;
            }
            
            // Check if there's an error
            const hasError = await this.page.evaluate(() => {
                const errorElements = document.querySelectorAll('[class*="error"], [class*="alert"]');
                return errorElements.length > 0;
            });
            
            if (hasError) {
                console.log("[BROWSER] ❌ Error detected on page");
                return false;
            }
            
            // Wait and check again
            await this.page.waitForTimeout(3000);
            
            // Take screenshot every 10 seconds for debugging
            if (Math.floor((Date.now() - startTime) / 10000) > Math.floor((Date.now() - startTime - 3000) / 10000)) {
                await this.page.screenshot({ path: `cloudflare_wait_${Date.now()}.png` });
                console.log("[BROWSER] 📸 Screenshot taken");
            }
        }
        
        console.log("[BROWSER] ❌ Cloudflare timeout exceeded");
        await this.page.screenshot({ path: 'cloudflare_timeout.png' });
        return false;
    }

    async login(retryCount = 0) {
        console.log("[BROWSER] Starting login process...");
        this.lastLoginAttempt = new Date();

        try {
            console.log("[BROWSER] Navigating to login page...");
            await this.page.goto(config.loginUrl, { 
                waitUntil: 'networkidle2',
                timeout: 60000 
            });

            console.log(`[BROWSER] Current URL: ${this.page.url()}`);
            console.log(`[BROWSER] Page title: ${await this.page.title()}`);

            // Handle Cloudflare challenge
            const pageContent = await this.page.content();
            if (pageContent.includes('Just a moment') || pageContent.includes('cf-challenge')) {
                const cfPassed = await this.handleCloudflare();
                if (!cfPassed) {
                    if (retryCount < config.maxRetries) {
                        console.log(`[BROWSER] Retrying login (${retryCount + 1}/${config.maxRetries})...`);
                        await this.page.reload({ waitUntil: 'networkidle2', timeout: 60000 });
                        return await this.login(retryCount + 1);
                    }
                    throw new Error("Cloudflare challenge could not be bypassed");
                }
            }

            // Wait for login form
            try {
                await this.page.waitForSelector('form', { timeout: 15000 });
                console.log("[BROWSER] Login form found!");
            } catch (e) {
                console.log("[BROWSER] No login form found, checking page content...");
                await this.page.screenshot({ path: 'no_form.png' });
                console.log("[BROWSER] Page content preview:", await this.page.evaluate(() => document.body.innerText.substring(0, 500)));
                throw new Error("Login form not found");
            }

            // Get CSRF token
            const csrfToken = await this.page.$eval('input[name="_token"]', el => el.value);
            console.log(`[BROWSER] CSRF Token: ${csrfToken}`);

            // Get Turnstile sitekey
            let sitekey = null;
            
            const turnstileDiv = await this.page.$('.cf-turnstile');
            if (turnstileDiv) {
                sitekey = await this.page.$eval('.cf-turnstile', el => el.getAttribute('data-sitekey'));
            }

            if (!sitekey) {
                console.log("[BROWSER] Looking for sitekey in scripts...");
                sitekey = await this.page.evaluate(() => {
                    const scripts = document.querySelectorAll('script');
                    for (const script of scripts) {
                        if (script.textContent && script.textContent.includes('sitekey')) {
                            const match = script.textContent.match(/['"]sitekey['"]:\s*['"]([^'"]+)['"]/);
                            if (match) return match[1];
                        }
                    }
                    return null;
                });
            }

            console.log(`[BROWSER] Sitekey: ${sitekey}`);

            if (!sitekey) {
                console.log("[BROWSER] ❌ No sitekey found!");
                await this.page.screenshot({ path: 'no_sitekey.png' });
                throw new Error("Could not find Turnstile sitekey");
            }

            // Solve captcha
            const captchaSolver = new CaptchaSolver(config.captchaApiKey);
            const solution = await captchaSolver.solveTurnstile(config.loginUrl, sitekey);
            const captchaToken = solution.token;

            console.log(`[CAPTCHA] Token received: ${captchaToken.substring(0, 50)}...`);

            // Fill login form
            await this.page.type('input[name="email"]', config.email);
            await this.page.type('input[name="password"]', config.password);

            // Inject captcha token
            await this.page.evaluate((token) => {
                const input = document.createElement('input');
                input.type = 'hidden';
                input.name = 'cf-turnstile-response';
                input.value = token;
                document.querySelector('form').appendChild(input);
            }, captchaToken);

            // Submit form
            console.log("[BROWSER] Submitting login form...");
            await Promise.all([
                this.page.click('button[type="submit"]'),
                this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 })
            ]);

            console.log(`[BROWSER] After login URL: ${this.page.url()}`);

            // Check if login successful
            const currentUrl = this.page.url();
            if (currentUrl.includes('dashboard') || currentUrl.includes('portal')) {
                console.log("[BROWSER] ✅ Login successful!");
                await this.page.screenshot({ path: 'login_success.png' });
                
                this.cookies = await this.page.cookies();
                this.isLoggedIn = true;
                console.log(`[BROWSER] Got ${this.cookies.length} cookies`);
                return true;
            } else {
                console.log("[BROWSER] ❌ Login failed!");
                await this.page.screenshot({ path: 'login_failed.png' });
                
                const errorMessage = await this.page.evaluate(() => {
                    const errors = document.querySelectorAll('.error, .alert, .alert-danger');
                    return errors.length > 0 ? errors[0].textContent : 'No error message';
                });
                console.log(`[BROWSER] Error: ${errorMessage}`);
                return false;
            }

        } catch (error) {
            console.error(`[BROWSER] Error: ${error.message}`);
            if (this.page) {
                await this.page.screenshot({ path: `error_${Date.now()}.png` });
            }
            return false;
        }
    }

    async refreshSession() {
        console.log("[BROWSER] Refreshing session...");
        if (this.browser) {
            await this.browser.close();
        }
        await this.init();
        return await this.login();
    }

    async getCookies() {
        return this.cookies;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            console.log("[BROWSER] Browser closed");
        }
    }

    getStatus() {
        return {
            isLoggedIn: this.isLoggedIn,
            cookies: this.cookies.length,
            lastLogin: this.lastLoginAttempt,
            url: this.page ? this.page.url() : null
        };
    }
}

// Express server
const app = express();
let browserSession = null;

app.get('/health', (req, res) => {
    const status = browserSession ? browserSession.getStatus() : { isLoggedIn: false };
    res.json({
        status: 'ok',
        time: new Date().toISOString(),
        browser: status
    });
});

app.get('/status', (req, res) => {
    if (browserSession) {
        res.json(browserSession.getStatus());
    } else {
        res.json({ status: 'not initialized' });
    }
});

app.get('/refresh', async (req, res) => {
    try {
        if (browserSession) {
            const success = await browserSession.refreshSession();
            res.json({ success, message: success ? 'Session refreshed' : 'Refresh failed' });
        } else {
            res.json({ success: false, message: 'No session' });
        }
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Main function
async function main() {
    console.log("=".repeat(60));
    console.log("Starting SMS Bot with Puppeteer + 2captcha");
    console.log("=".repeat(60));

    // Start express server
    app.listen(config.port, () => {
        console.log(`[SERVER] Health check running on port ${config.port}`);
        console.log(`[SERVER] Health endpoint: http://localhost:${config.port}/health`);
    });

    // Initialize browser with retry
    let retries = 0;
    let loginSuccess = false;
    
    while (retries < config.maxRetries && !loginSuccess) {
        try {
            console.log(`\n[MAIN] Attempt ${retries + 1}/${config.maxRetries}`);
            
            browserSession = new BrowserSession();
            await browserSession.init();

            console.log("\n[MAIN] Performing initial login...");
            loginSuccess = await browserSession.login();
            
            if (!loginSuccess) {
                console.log(`[MAIN] ❌ Login attempt ${retries + 1} failed`);
                if (browserSession) {
                    await browserSession.close();
                }
                retries++;
                if (retries < config.maxRetries) {
                    console.log(`[MAIN] Waiting 30 seconds before retry...`);
                    await new Promise(resolve => setTimeout(resolve, 30000));
                }
            }
        } catch (error) {
            console.error(`[MAIN] Error on attempt ${retries + 1}: ${error.message}`);
            retries++;
            if (retries < config.maxRetries) {
                console.log(`[MAIN] Waiting 30 seconds before retry...`);
                await new Promise(resolve => setTimeout(resolve, 30000));
            }
        }
    }
    
    if (loginSuccess) {
        console.log("[MAIN] ✅ Bot is ready!");
        
        // Setup cron job to refresh session every 30 minutes
        cron.schedule('*/30 * * * *', async () => {
            console.log("\n[CRON] Refreshing session...");
            try {
                const success = await browserSession.refreshSession();
                console.log(`[CRON] Session refresh: ${success ? '✅ Success' : '❌ Failed'}`);
            } catch (error) {
                console.error(`[CRON] Error: ${error.message}`);
            }
        });
        
        console.log("[MAIN] Cron job scheduled (every 30 minutes)");

        // Keep the process alive
        console.log("[MAIN] Bot running. Press Ctrl+C to stop.");
        console.log("=".repeat(60));
        
        // Periodic status check
        setInterval(() => {
            const status = browserSession.getStatus();
            console.log(`[HEARTBEAT] Status: Logged In: ${status.isLoggedIn}, Cookies: ${status.cookies}`);
        }, 60000);
        
    } else {
        console.log("[MAIN] ❌ All login attempts failed!");
        console.log("[MAIN] Please check:");
        console.log("  1. 2captcha API key is valid");
        console.log("  2. Credentials are correct");
        console.log("  3. The website is accessible");
        console.log("  4. There's enough balance in 2captcha");
    }
}

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log("\n[SHUTDOWN] Received SIGINT. Cleaning up...");
    if (browserSession) {
        await browserSession.close();
    }
    process.exit(0);
});

process.on('SIGTERM', async () => {
    console.log("\n[SHUTDOWN] Received SIGTERM. Cleaning up...");
    if (browserSession) {
        await browserSession.close();
    }
    process.exit(0);
});

// Run
main().catch(error => {
    console.error(`[MAIN] Fatal error: ${error.message}`);
    process.exit(1);
});
