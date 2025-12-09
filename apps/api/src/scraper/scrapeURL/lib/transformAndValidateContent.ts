import { ScrapeOptions } from "../../../controllers/v2/types";
import { htmlTransform } from "./removeUnwantedElements";
import { parseMarkdown } from "../../../lib/html-to-markdown";

/**
 * Transforms HTML and converts to markdown for quality checking.
 * This is used to validate that the engine successfully scraped content
 * (to detect cases where Chrome returns empty HTML).
 *
 * The transformed HTML and markdown are returned so they can be reused
 * by transformers to avoid duplicate conversion.
 *
 * @param html - Raw HTML from the engine
 * @param url - URL being scraped
 * @param options - Scrape options (including onlyMainContent)
 * @returns Object containing transformed HTML and markdown, plus whether onlyMainContent was used
 */
export async function transformAndValidateContent(
  html: string,
  url: string,
  options: ScrapeOptions,
): Promise<{
  transformedHtml: string;
  markdown: string;
  usedOnlyMainContent: boolean;
}> {
  const useOnlyMainContent = options.onlyMainContent ?? true;

  // Transform HTML and convert to markdown
  let transformedHtml = await htmlTransform(html, url, {
    ...options,
    onlyMainContent: useOnlyMainContent,
  });
  let markdown = await parseMarkdown(transformedHtml);
  let usedOnlyMainContent = useOnlyMainContent;

  // Fallback to full content if main content extraction resulted in empty markdown
  if (markdown.trim().length === 0 && useOnlyMainContent) {
    transformedHtml = await htmlTransform(html, url, {
      ...options,
      onlyMainContent: false,
    });
    markdown = await parseMarkdown(transformedHtml);
    usedOnlyMainContent = false;
  }

  return {
    transformedHtml,
    markdown,
    usedOnlyMainContent,
  };
}
