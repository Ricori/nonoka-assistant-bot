declare module 'puppeteer' {
  export interface LaunchOptions {
    headless?: boolean;
    executablePath?: string;
    args?: string[];
  }
  export interface ElementHandle {
    screenshot(options?: { type?: 'png' | 'jpeg'; encoding?: 'base64' | 'binary' }): Promise<Buffer | string>;
  }
  export interface Page {
    setViewport(viewport: { width: number; height: number; deviceScaleFactor?: number }): Promise<void>;
    setContent(html: string, options?: { waitUntil?: string; timeout?: number }): Promise<void>;
    $(selector: string): Promise<ElementHandle | null>;
    close(): Promise<void>;
  }
  export interface Browser {
    isConnected(): boolean;
    newPage(): Promise<Page>;
    close(): Promise<void>;
  }
  export function launch(options?: LaunchOptions): Promise<Browser>;
  const puppeteer: { launch: typeof launch };
  export default puppeteer;
}
