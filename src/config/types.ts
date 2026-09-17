export interface PlainQLConfig {
    connection: {
        url: string;
        readonlyUrl?: string;
    },
    ai: AIConfig;
}

export interface AIConfig {
    provider : "openai" | "anthropic";
    apiKey?: string;
    model?: string;
    cache?: {
        enabled: boolean;
        ttl?: number;
        storage?: "memory" | "file";
    } 
}
