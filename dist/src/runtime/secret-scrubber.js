export class SecretScrubber {
    rules = [];
    options;
    constructor(options = {}) {
        this.options = {
            genericMask: options.genericMask ?? false,
            scrubEnvironmentSecrets: options.scrubEnvironmentSecrets ?? true,
            customSecrets: options.customSecrets ?? [],
            customEnv: options.customEnv ?? (typeof process !== "undefined" ? process.env : {}),
        };
        this.initializeRules();
    }
    initializeRules() {
        const mask = (tag) => (this.options.genericMask ? "[REDACTED_SECRET]" : `[REDACTED_${tag}]`);
        this.rules.push(
        // Google Gemini / Vertex API Keys
        {
            name: "GEMINI_KEY",
            pattern: /\bAIzaSy[A-Za-z0-9_-]{33}\b/g,
            replacement: mask("GEMINI_KEY"),
        }, 
        // OpenAI Project API Keys
        {
            name: "OPENAI_PROJ_KEY",
            pattern: /\bsk-proj-[A-Za-z0-9_-]{48,160}\b/g,
            replacement: mask("OPENAI_KEY"),
        }, 
        // OpenAI Service / Admin Keys
        {
            name: "OPENAI_ADMIN_KEY",
            pattern: /\bsk-admin-[A-Za-z0-9_-]{48,160}\b/g,
            replacement: mask("OPENAI_KEY"),
        }, 
        // OpenAI Organization Keys
        {
            name: "OPENAI_ORG_KEY",
            pattern: /\bsk-org-[A-Za-z0-9_-]{48,160}\b/g,
            replacement: mask("OPENAI_KEY"),
        }, 
        // OpenAI Standard / Legacy Secret Keys
        {
            name: "OPENAI_KEY",
            pattern: /\bsk-[A-Za-z0-9]{32,64}\b/g,
            replacement: mask("OPENAI_KEY"),
        }, 
        // Anthropic Claude API Keys
        {
            name: "ANTHROPIC_KEY",
            pattern: /\bsk-ant-(?:api[0-9]{2}-)?[A-Za-z0-9_-]{32,140}\b/g,
            replacement: mask("ANTHROPIC_KEY"),
        }, 
        // GitHub Classic Personal Access Tokens
        {
            name: "GITHUB_PAT",
            pattern: /\bghp_[A-Za-z0-9]{36}\b/g,
            replacement: mask("GITHUB_PAT"),
        }, 
        // GitHub Fine-Grained Personal Access Tokens
        {
            name: "GITHUB_FINE_GRAINED_PAT",
            pattern: /\bgithub_pat_[A-Za-z0-9_]{40,120}\b/g,
            replacement: mask("GITHUB_PAT"),
        }, 
        // GitHub OAuth / User / Server / Refresh Tokens
        {
            name: "GITHUB_TOKEN",
            pattern: /\b(?:gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/g,
            replacement: mask("GITHUB_TOKEN"),
        }, 
        // HTTP Authorization Bearer Tokens
        {
            name: "BEARER_TOKEN",
            pattern: /(Bearer\s+)[A-Za-z0-9_\-\.~+/]+=*/gi,
            replacement: (_match, p1) => `${p1}${mask("BEARER_TOKEN")}`,
        }, 
        // Basic Auth Credentials in URLs
        {
            name: "URL_CREDENTIALS",
            pattern: /(https?:\/\/)[^:\/\s@]+:[^@\/\s]+@/gi,
            replacement: (_match, p1) => `${p1}${mask("CREDENTIALS")}@`,
        }, 
        // AWS Access Key IDs
        {
            name: "AWS_ACCESS_KEY",
            pattern: /\b(?:AKIA|ASIA|AROA|AIDA)[A-Z0-9]{16}\b/g,
            replacement: mask("AWS_KEY"),
        }, 
        // Slack Tokens
        {
            name: "SLACK_TOKEN",
            pattern: /\bxox[baprs]-[0-9]{10,14}-[0-9]{10,14}[a-zA-Z0-9-]*\b/g,
            replacement: mask("SLACK_TOKEN"),
        }, 
        // Private Keys (PEM format)
        {
            name: "PEM_PRIVATE_KEY",
            pattern: /-----BEGIN (?:[A-Z0-9_-]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9_-]+ )?PRIVATE KEY-----/g,
            replacement: mask("PRIVATE_KEY"),
        });
    }
    /**
     * Assainit une chaîne de caractères en masquant tous les secrets reconnus.
     */
    scrub(text) {
        if (!text || typeof text !== "string") {
            return text;
        }
        let result = text;
        // 1. Application des règles d'expressions régulières statiques
        for (const rule of this.rules) {
            if (typeof rule.replacement === "function") {
                result = result.replace(rule.pattern, rule.replacement);
            }
            else {
                result = result.replace(rule.pattern, rule.replacement);
            }
        }
        // 2. Masquage dynamique des variables d'environnement
        if (this.options.scrubEnvironmentSecrets) {
            result = this.scrubEnvValues(result);
        }
        // 3. Masquage des secrets personnalisés injectés
        for (const secret of this.options.customSecrets) {
            if (secret && secret.length >= 6) {
                result = result.replaceAll(secret, this.options.genericMask ? "[REDACTED_SECRET]" : "[REDACTED_CUSTOM_SECRET]");
            }
        }
        return result;
    }
    /**
     * Parcourt et assainit récursivement toutes les chaînes contenues dans un objet ou tableau.
     */
    scrubObject(value) {
        if (value === null || value === undefined) {
            return value;
        }
        if (typeof value === "string") {
            return this.scrub(value);
        }
        if (Array.isArray(value)) {
            return value.map((item) => this.scrubObject(item));
        }
        if (typeof value === "object") {
            const result = {};
            for (const [k, v] of Object.entries(value)) {
                result[k] = this.scrubObject(v);
            }
            return result;
        }
        return value;
    }
    scrubEnvValues(text) {
        let result = text;
        const candidates = [];
        const sensitiveKeyRegex = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE|SIGNING|PASSPHRASE|APIKEY/i;
        for (const [key, value] of Object.entries(this.options.customEnv)) {
            if (!value || typeof value !== "string" || value.length < 8) {
                continue;
            }
            if (sensitiveKeyRegex.test(key)) {
                candidates.push({ key, value });
            }
        }
        // Trier par longueur décroissante pour traiter les secrets longs en premier
        candidates.sort((a, b) => b.value.length - a.value.length);
        for (const { key, value } of candidates) {
            const escaped = escapeRegExp(value);
            const regex = new RegExp(escaped, "g");
            const mask = this.options.genericMask ? "[REDACTED_SECRET]" : `[REDACTED_ENV_${key}]`;
            result = result.replace(regex, mask);
        }
        return result;
    }
}
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Instance globale par défaut pour usage immédiat */
export const defaultSecretScrubber = new SecretScrubber();
