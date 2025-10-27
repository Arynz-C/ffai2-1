import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, query, url } = await req.json();

    if (action === 'search') {
      const urls = await searchDuckDuckGo(query);
      return new Response(JSON.stringify({ urls }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'fetch') {
      const content = await getWebpageContent(url);
      return new Response(JSON.stringify({ content }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (action === 'searchAndFetch') {
      const urls = await searchDuckDuckGo(query);
      const results = await Promise.all(
        urls.map(async (url: string) => {
          const content = await getWebpageContent(url);
          return content ? { url, content } : null;
        })
      );
      
      const filteredResults = results.filter(r => r !== null);
      return new Response(JSON.stringify({ results: filteredResults }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Invalid action' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

async function searchDuckDuckGo(query: string): Promise<string[]> {
  try {
    console.log('🔍 Searching for:', query);
    
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(searchUrl)}`;
    
    const response = await fetch(proxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`Search failed: ${response.status}`);
    }
    
    const data = await response.json();
    if (!data.contents) {
      return [];
    }
    
    // Parse HTML
    const htmlContent = data.contents;
    const urlPattern = /uddg=([^"&]+)/g;
    const matches = [...htmlContent.matchAll(urlPattern)];
    
    const results: string[] = [];
    for (const match of matches) {
      try {
        const decodedUrl = decodeURIComponent(match[1]);
        if (isValidUrl(decodedUrl)) {
          results.push(decodedUrl);
          if (results.length >= 3) break;
        }
      } catch (e) {
        continue;
      }
    }
    
    console.log(`🔗 Found ${results.length} URLs`);
    return results;
  } catch (error) {
    console.error('❌ Search error:', error);
    return [];
  }
}

function isValidUrl(string: string): boolean {
  try {
    const url = new URL(string);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

async function getWebpageContent(url: string): Promise<string | null> {
  try {
    console.log(`🌐 Fetching content from: ${url}`);
    
    const proxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
    
    const response = await fetch(proxyUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    const data = await response.json();
    if (!data.contents || data.contents.length < 100) {
      return null;
    }
    
    console.log(`✅ Fetched ${data.contents.length} characters`);
    return extractTextContent(data.contents);
  } catch (error) {
    console.error(`❌ Content fetch failed for ${url}:`, error);
    return null;
  }
}

function extractTextContent(html: string): string | null {
  try {
    // Simple text extraction - remove HTML tags
    let text = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Take first 3000 characters
    text = text.substring(0, 3000);
    
    console.log(`📊 Extracted ${text.length} chars`);
    return text.length > 50 ? text : null;
  } catch (error) {
    console.error('❌ Content extraction error:', error);
    return null;
  }
}
