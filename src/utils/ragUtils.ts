// RAG utilities for search and calculator tools
import { supabase } from '@/integrations/supabase/client';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

// Use edge function for search to avoid CORS issues
export async function searchDuckDuckGo(query: string): Promise<string[]> {
  try {
    console.log('🔍 Starting search via edge function:', query);
    
    const { data, error } = await supabase.functions.invoke('web-scraper', {
      body: { action: 'search', query }
    });
    
    if (error) throw error;
    
    console.log(`🔗 Found ${data.urls.length} URLs`);
    return data.urls || [];
  } catch (error) {
    console.error('❌ Search error:', error);
    return [];
  }
}


// Use edge function for fetching to avoid CORS issues
export async function getWebpageContent(url: string): Promise<string | null> {
  try {
    console.log(`🌐 Fetching content via edge function: ${url}`);
    
    const { data, error } = await supabase.functions.invoke('web-scraper', {
      body: { action: 'fetch', url }
    });
    
    if (error) throw error;
    
    console.log(`✅ Fetched content`);
    return data.content;
  } catch (error) {
    console.error(`❌ Failed to get content from ${url}:`, error);
    return null;
  }
}

// Use edge function for search and fetch to avoid CORS issues
export async function searchAndFetchContent(query: string): Promise<{url: string, content: string}[]> {
  try {
    console.log('🚀 Starting search and fetch via edge function:', query);
    
    const { data, error } = await supabase.functions.invoke('web-scraper', {
      body: { action: 'searchAndFetch', query }
    });
    
    if (error) throw error;
    
    console.log(`✅ Successfully fetched content from ${data.results.length} URLs`);
    return data.results || [];
  } catch (error) {
    console.error('❌ Search and fetch error:', error);
    return [];
  }
}

// This function is now deprecated - use the Edge Function instead
export async function getOllamaResponse(prompt: string, ollamaUrl?: string): Promise<string> {
  return 'This function is deprecated. Use the Edge Function instead.';
}