import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-requested-with',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS, HEAD, PATCH',
  'Access-Control-Max-Age': '86400',
  'Access-Control-Allow-Credentials': 'true',
}

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Parse JSON with error handling
    let requestBody;
    try {
      const rawBody = await req.text();
      if (!rawBody || rawBody.trim() === '') {
        throw new Error('Empty request body');
      }
      requestBody = JSON.parse(rawBody);
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      return new Response(
        JSON.stringify({ error: 'Invalid JSON in request body' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    const { prompt, model = 'FireFlies:latest', action, image, stream = true, messages = [], searchContext = null, webContext = null } = requestBody;
    console.log(`🤖 Received model: ${model}, action: ${action}`);
    
    // Get Ollama API Key for Cloud API
    const ollamaApiKey = Deno.env.get('OLLAMA_API_KEY');
    if (!ollamaApiKey) {
      console.error('OLLAMA_API_KEY not configured');
      return new Response(
        JSON.stringify({ error: 'Ollama API key not configured' }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }
    
    // Initialize Supabase client
    const supabaseClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );
    
    // Get auth header and check subscription status
    const authHeader = req.headers.get("Authorization");
    let isProUser = false;
    
    if (authHeader && action !== 'search') {
      try {
        const token = authHeader.replace("Bearer ", "");
        const { data: userData, error: userError } = await supabaseClient.auth.getUser(token);
        
        console.log('Auth check result:', { userError: userError?.message, userId: userData?.user?.id });
        
        if (!userError && userData.user) {
          console.log('Querying profiles for user_id:', userData.user.id);
          try {
            const { data: profile, error: profileError } = await supabaseClient
              .from('profiles')
              .select('subscription_plan')
              .eq('user_id', userData.user.id)
              .maybeSingle();
            
            console.log('Profile query result:', { 
              profileError: profileError?.message, 
              profile: profile,
              subscriptionPlan: profile?.subscription_plan 
            });
            
            isProUser = profile?.subscription_plan === 'pro' || false;
            console.log('Final isProUser status:', isProUser);
          } catch (profileLookupError) {
            console.error('Profile lookup error:', profileLookupError);
            isProUser = false;
          }
        }
      } catch (error) {
        console.error('Error checking subscription:', error);
      }
    }
    
    console.log('Final auth status:', { isProUser, authHeader: !!authHeader, action });
    
    // Handle get models functionality
    if (action === 'get_models') {
      console.log('Fetching available models from Ollama Cloud');
      
      try {
        const modelsResponse = await fetch('https://ollama.com/api/tags');
        
        if (!modelsResponse.ok) {
          console.error(`Models API error: ${modelsResponse.status}`);
          throw new Error(`Models API error: ${modelsResponse.status}`);
        }
        
        const modelsData = await modelsResponse.json();
        const allModels = modelsData.models || [];
        
        console.log('Models fetched from Ollama Cloud:', allModels.length);
        
        return new Response(JSON.stringify({ models: allModels }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        
      } catch (modelsError) {
        console.error('Models fetch error:', modelsError);
        return new Response(JSON.stringify({ 
          models: [], 
          error: 'Failed to fetch models from Ollama Cloud' 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Handle search action - use web-scraper function
    if (action === 'search') {
      console.log('🔍 Performing search for:', prompt);
      
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Call web-scraper function to search
        const { data: searchData, error: searchError } = await supabase.functions.invoke('web-scraper', {
          body: { 
            action: 'search', 
            query: prompt 
          }
        });

        if (searchError) {
          console.error('Search error:', searchError);
          return new Response(JSON.stringify({ 
            urls: [],
            error: searchError.message 
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        const urls = searchData?.urls || [];
        console.log(`✅ Search found ${urls.length} URLs`);
        
        return new Response(JSON.stringify({ urls }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        
      } catch (error) {
        console.error('Search error:', error);
        return new Response(JSON.stringify({ 
          urls: [],
          error: error instanceof Error ? error.message : 'Unknown error' 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Handle web fetch action - use web-scraper function
    if (action === 'web') {
      const targetUrl = requestBody.url;
      console.log('🌐 Fetching web content from:', targetUrl);
      
      if (!targetUrl) {
        return new Response(JSON.stringify({ error: 'URL is required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
        const supabase = createClient(supabaseUrl, supabaseKey);
        
        // Call web-scraper function to fetch
        const { data: fetchData, error: fetchError } = await supabase.functions.invoke('web-scraper', {
          body: { 
            action: 'fetch', 
            url: targetUrl 
          }
        });

        if (fetchError) {
          console.error('Fetch error:', fetchError);
          return new Response(JSON.stringify({ 
            content: '',
            error: fetchError.message 
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        const content = fetchData?.content || '';
        const title = fetchData?.title || 'Web Page';
        console.log(`✅ Fetched content, length: ${content.length}`);
        
        return new Response(JSON.stringify({ content, title, url: targetUrl }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        
      } catch (error) {
        console.error('Web fetch error:', error);
        return new Response(JSON.stringify({ 
          content: '',
          error: error instanceof Error ? error.message : 'Unknown error' 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Regular chat with optional search/web context
    console.log('💬 Processing chat request');
    
    // Build system message with context if provided
    let systemMessage = 'Kamu adalah asisten AI yang membantu dan ramah. Jawab dalam Bahasa Indonesia dengan informasi yang akurat dan berguna.';
    
    if (searchContext) {
      systemMessage = `Kamu adalah asisten AI yang membantu mencari informasi. Berikut adalah hasil pencarian web yang relevan:

${searchContext.map((item: { url: string; content: string }, idx: number) => 
  `--- Sumber ${idx + 1}: ${item.url} ---
${item.content}
`).join('\n')}

Berdasarkan informasi di atas, jawab pertanyaan pengguna dengan lengkap dan akurat dalam Bahasa Indonesia. Jangan sebutkan bahwa kamu membaca dari sumber, langsung berikan jawaban yang informatif.`;
    }
    
    if (webContext) {
      systemMessage = `Kamu adalah asisten AI yang membantu menganalisis konten website. Berikut adalah konten dari ${webContext.url}:

${webContext.content}

Berdasarkan konten website di atas, jawab pertanyaan pengguna dengan lengkap dan akurat dalam Bahasa Indonesia.`;
    }
    
    // Build messages array
    let chatMessages = messages.length > 0 ? [...messages] : [
      { role: 'user', content: prompt }
    ];
    
    // Add system message at the beginning
    chatMessages = [
      { role: 'system', content: systemMessage },
      ...chatMessages.filter((m: any) => m.role !== 'system')
    ];
    
    // Handle vision requests
    if (image) {
      console.log('🖼️ Processing vision request');
      chatMessages = chatMessages.map((msg: any) => {
        if (msg.role === 'user' && msg === chatMessages[chatMessages.length - 1]) {
          return {
            role: 'user',
            content: msg.content,
            images: [image.replace(/^data:image\/\w+;base64,/, '')]
          };
        }
        return msg;
      });
    }
    
    // Check for think mode
    const useThinking = prompt?.toLowerCase().includes('/pikir') || chatMessages.some((m: any) => 
      m.role === 'user' && m.content?.toLowerCase().includes('/pikir')
    );
    
    console.log(`📤 Sending request to Ollama, model: ${model}, thinking: ${useThinking}`);
    
    // Make request to Ollama
    const ollamaResponse = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ollamaApiKey}`
      },
      body: JSON.stringify({
        model,
        messages: chatMessages,
        stream: true,
        ...(useThinking ? { think: true } : {})
      })
    });

    if (!ollamaResponse.ok) {
      const errorText = await ollamaResponse.text();
      console.error('Ollama API error:', ollamaResponse.status, errorText);
      return new Response(
        JSON.stringify({ error: `Ollama API error: ${ollamaResponse.status}` }),
        { 
          status: 500, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Stream response back to client
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    (async () => {
      try {
        const reader = ollamaResponse.body?.getReader();
        if (!reader) throw new Error('No response body');

        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value);
          const lines = chunk.split('\n').filter(line => line.trim());

          for (const line of lines) {
            try {
              const json = JSON.parse(line);
              
              if (json.message) {
                // Stream thinking if present
                if (json.message.thinking) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({
                    type: 'thinking',
                    content: json.message.thinking
                  })}\n\n`));
                }

                // Stream content if present
                if (json.message.content) {
                  await writer.write(encoder.encode(`data: ${JSON.stringify({
                    type: 'content',
                    content: json.message.content
                  })}\n\n`));
                }
              }

              if (json.done) {
                await writer.write(encoder.encode(`data: [DONE]\n\n`));
                break;
              }
            } catch (e) {
              // Ignore parse errors for partial chunks
            }
          }
        }

        await writer.close();
      } catch (error) {
        console.error('Stream error:', error);
        await writer.write(encoder.encode(`data: ${JSON.stringify({
          type: 'error',
          content: error instanceof Error ? error.message : 'Unknown error'
        })}\n\n`));
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        ...corsHeaders,
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    });

  } catch (error) {
    console.error('Edge function error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error' }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
});
