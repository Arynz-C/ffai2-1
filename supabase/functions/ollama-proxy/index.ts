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

    const { prompt, model = 'FireFlies:latest', action, image, stream = true, useTools = false, messages = [] } = requestBody;
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
            
            // Default to false if profile not found or error occurs
            isProUser = profile?.subscription_plan === 'pro' || false;
            console.log('Final isProUser status:', isProUser);
          } catch (profileLookupError) {
            console.error('Profile lookup error:', profileLookupError);
            isProUser = false; // Default to free user on error
          }
        }
      } catch (error) {
        console.error('Error checking subscription:', error);
      }
    }
    
    console.log('Final auth status:', { isProUser, authHeader: !!authHeader, action });
    
    // Check model access restrictions - temporarily allow all models for debugging
    const isFreeModel = model === 'FireFlies:latest';
    console.log('Model access check:', { 
      model, 
      isFreeModel, 
      isProUser, 
      action,
      bypassCheck: true 
    });
    
    // Temporarily allow all models regardless of subscription
    // if (!isProUser && !isFreeModel && action !== 'search') {
    //   return new Response(
    //     JSON.stringify({ 
    //       error: 'Model ini hanya tersedia untuk pengguna Pro. Silakan upgrade subscription atau gunakan model FireFlies:latest.' 
    //     }),
    //     { 
    //       status: 403, 
    //       headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
    //     }
    //   );
    // }
    
    // Handle get models functionality - list all available models
    if (action === 'get_models') {
      console.log('Fetching available models from Ollama Cloud');
      
      try {
        // Ollama Cloud API /api/tags endpoint doesn't require authentication
        const modelsResponse = await fetch('https://ollama.com/api/tags');
        
        if (!modelsResponse.ok) {
          console.error(`Models API error: ${modelsResponse.status}`);
          const errorText = await modelsResponse.text();
          console.error('Error response:', errorText);
          throw new Error(`Models API error: ${modelsResponse.status}`);
        }
        
        const modelsData = await modelsResponse.json();
        console.log('Raw models data:', JSON.stringify(modelsData).substring(0, 500));
        
        const allModels = modelsData.models || [];
        
        console.log('Models fetched from Ollama Cloud:', allModels.length);
        console.log('Available models:', allModels.map((m: any) => m.name).join(', '));
        
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
    
    // Handle chat with tool calling (webSearch and webFetch)
    if (useTools) {
      console.log('🔧 Using tool calling mode with webSearch and webFetch');
      
      try {
        // Define tool schemas
        const webSearchTool = {
          type: 'function',
          function: {
            name: 'webSearch',
            description: 'Performs a web search for the given query.',
            parameters: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query string.' },
                max_results: {
                  type: 'number',
                  description: 'The maximum number of results to return per query (default 3).',
                },
              },
              required: ['query'],
            },
          },
        };

        const webFetchTool = {
          type: 'function',
          function: {
            name: 'webFetch',
            description: 'Fetches a single page by URL.',
            parameters: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'A single URL to fetch.' },
              },
              required: ['url'],
            },
          },
        };

        // Initialize conversation messages with system prompt
        const systemMessage = {
          role: 'system',
          content: 'Kamu adalah asisten AI yang membantu pengguna dengan pencarian web. Gunakan tools webSearch untuk mencari informasi dan webFetch untuk membaca konten halaman web. Setelah mendapat hasil dari tools, WAJIB berikan jawaban lengkap dan informatif dalam Bahasa Indonesia berdasarkan informasi yang ditemukan. Jangan hanya menyebutkan sumber, tapi jelaskan isinya secara detail.'
        };
        
        let conversationMessages = messages.length > 0 
          ? [systemMessage, ...messages] 
          : [systemMessage, { role: 'user', content: prompt }];

        // Tool execution loop
        let maxIterations = 5;
        let iteration = 0;
        
        // Create a TransformStream for streaming response
        const { readable, writable } = new TransformStream();
        const writer = writable.getWriter();
        const encoder = new TextEncoder();

        // Process in background
        (async () => {
          try {
            let collectedUrls: string[] = [];
            
            while (iteration < maxIterations) {
              iteration++;
              console.log(`🔄 Tool calling iteration ${iteration}`);

              // After 3 iterations, stop providing tools to force final response
              const shouldProvideTools = iteration <= 3;
              
              const requestBody: any = {
                model,
                messages: conversationMessages,
                stream: true,
              };
              
              if (shouldProvideTools) {
                requestBody.tools = [webSearchTool, webFetchTool];
              }
              
              console.log(`📤 Request iteration ${iteration}, tools enabled: ${shouldProvideTools}`);

              const ollamaResponse = await fetch('https://ollama.com/api/chat', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${ollamaApiKey}`
                },
                body: JSON.stringify(requestBody)
              });

              if (!ollamaResponse.ok) {
                throw new Error(`Ollama API error: ${ollamaResponse.status}`);
              }

              let accumulatedContent = '';
              let accumulatedThinking = '';
              let toolCalls: any[] = [];
              let hasToolCalls = false;

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
                        accumulatedThinking += json.message.thinking;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({
                          type: 'thinking',
                          content: json.message.thinking
                        })}\n\n`));
                      }

                      // Stream content if present
                      if (json.message.content) {
                        accumulatedContent += json.message.content;
                        await writer.write(encoder.encode(`data: ${JSON.stringify({
                          type: 'content',
                          content: json.message.content
                        })}\n\n`));
                      }

                      // Collect tool calls
                      if (json.message.tool_calls && json.message.tool_calls.length > 0) {
                        hasToolCalls = true;
                        toolCalls = json.message.tool_calls;
                      }
                    }

                    if (json.done) break;
                  } catch (e) {
                    console.error('Error parsing JSON line:', e);
                  }
                }
              }

              // If no tool calls, we're done - add sources and signal done
              if (!hasToolCalls) {
                console.log(`✅ Final response complete. Content length: ${accumulatedContent.length}, URLs collected: ${collectedUrls.length}`);
                
                // Add source URLs at the end if we have any
                if (collectedUrls.length > 0) {
                  const sourcesText = '\n\n---\n📚 **Sumber:**\n' + collectedUrls.map((url, idx) => `${idx + 1}. ${url}`).join('\n');
                  await writer.write(encoder.encode(`data: ${JSON.stringify({
                    type: 'content',
                    content: sourcesText
                  })}\n\n`));
                }
                
                await writer.write(encoder.encode(`data: [DONE]\n\n`));
                break;
              }

              // Execute tool calls
              console.log(`🔧 Executing ${toolCalls.length} tool call(s)`);
              
              // Add assistant message with tool calls
              conversationMessages.push({
                role: 'assistant',
                content: accumulatedContent,
                thinking: accumulatedThinking,
                tool_calls: toolCalls
              });

              for (const toolCall of toolCalls) {
                const functionName = toolCall.function.name;
                const args = toolCall.function.arguments;

                console.log(`📞 Calling ${functionName} with args:`, args);

                await writer.write(encoder.encode(`data: ${JSON.stringify({
                  type: 'tool_call',
                  function: functionName,
                  arguments: args
                })}\n\n`));

                let toolResult: any;

                if (functionName === 'webSearch') {
                  try {
                    console.log(`🔍 Using web-scraper for search: "${args.query}"`);
                    
                    // Initialize Supabase client
                    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    
                    const { data: searchData, error: searchError } = await supabase.functions.invoke('web-scraper', {
                      body: { 
                        action: 'search', 
                        query: args.query 
                      }
                    });

                    if (searchError) {
                      console.error(`❌ webSearch failed:`, searchError);
                      toolResult = { error: `Search failed: ${searchError.message}` };
                    } else {
                      // Format results for the model
                      const urls = searchData.urls || [];
                      toolResult = {
                        results: urls.map((url: string, idx: number) => ({
                          title: `Result ${idx + 1}`,
                          url: url,
                          snippet: `Found result for: ${args.query}`
                        }))
                      };
                      console.log(`✅ webSearch success: ${urls.length} results`);
                    }
                  } catch (error) {
                    console.error('❌ webSearch exception:', error);
                    toolResult = { error: `Search error: ${error instanceof Error ? error.message : 'Unknown'}` };
                  }
                } else if (functionName === 'webFetch') {
                  try {
                    console.log(`🌐 Using web-scraper for fetch: ${args.url}`);
                    
                    // Collect URL for sources
                    if (args.url && !collectedUrls.includes(args.url)) {
                      collectedUrls.push(args.url);
                    }
                    
                    // Initialize Supabase client
                    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
                    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
                    const supabase = createClient(supabaseUrl, supabaseKey);
                    
                    const { data: fetchData, error: fetchError } = await supabase.functions.invoke('web-scraper', {
                      body: { 
                        action: 'fetch', 
                        url: args.url 
                      }
                    });

                    if (fetchError) {
                      console.error(`❌ webFetch failed:`, fetchError);
                      toolResult = { error: `Fetch failed: ${fetchError.message}` };
                    } else {
                      toolResult = {
                        url: args.url,
                        content: fetchData.content || '',
                        title: fetchData.title || 'Web Page'
                      };
                      
                      // Limit content size
                      if (toolResult.content && toolResult.content.length > 8000) {
                        toolResult.content = toolResult.content.substring(0, 8000);
                      }
                      
                      console.log(`✅ webFetch success for ${args.url}`);
                    }
                  } catch (error) {
                    console.error('❌ webFetch exception:', error);
                    toolResult = { error: `Fetch error: ${error instanceof Error ? error.message : 'Unknown'}` };
                  }
                }

                // Add tool result to conversation
                conversationMessages.push({
                  role: 'tool',
                  content: JSON.stringify(toolResult),
                  tool_name: functionName
                });
              }
            }

            await writer.close();
          } catch (error) {
            console.error('Tool calling error:', error);
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
        console.error('Tool calling setup error:', error);
        return new Response(JSON.stringify({ 
          error: `Tool calling failed: ${error instanceof Error ? error.message : 'Unknown error'}` 
        }), {
          status: 500,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Handle search functionality - get top 4 sites and download content
    if (action === 'search') {
      console.log('Performing search for:', prompt);
      
      try {
        // Use multiple CORS proxies as fallback
        const proxies = [
          'https://corsproxy.io/?',
          'https://api.codetabs.com/v1/proxy?quest=',
          'https://thingproxy.freeboard.io/fetch/'
        ];
        
        let searchResults = [];
        
        for (const proxyUrl of proxies) {
          try {
            const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(prompt)}`;
            const fullUrl = proxyUrl + encodeURIComponent(searchUrl);
            
            console.log('🔍 Trying search with proxy:', proxyUrl);
            
            const response = await fetch(fullUrl, {
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EdgeFunction/1.0)'
              }
            });
            
            if (response.ok) {
              const data = proxyUrl.includes('allorigins') ? 
                await response.json().then(d => d.contents) : 
                await response.text();
              
              // Simple regex-based HTML parsing for search results
              const resultPattern = /<div[^>]*class="[^"]*result[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
              const linkPattern = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
              const snippetPattern = /<div[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
              
              let match;
              let count = 0;
              
              while ((match = resultPattern.exec(data)) !== null && count < 4) {
                const resultHtml = match[1];
                const linkMatch = linkPattern.exec(resultHtml);
                
                if (linkMatch && linkMatch[1]) {
                  try {
                    const href = linkMatch[1];
                    const url = new URL(href, 'https://duckduckgo.com');
                    const realUrl = url.searchParams.get('uddg');
                    
                    if (realUrl) {
                      const decodedUrl = decodeURIComponent(realUrl);
                      
                      // Extract title (from link text, remove HTML tags)
                      const title = linkMatch[2]?.replace(/<[^>]*>/g, '').trim() || 'No title';
                      
                      // Extract snippet
                      const snippetMatch = snippetPattern.exec(resultHtml);
                      const snippet = snippetMatch?.[1]?.replace(/<[^>]*>/g, '').trim() || 'No description';
                      
                      searchResults.push({
                        title,
                        snippet,
                        url: decodedUrl
                      });
                      count++;
                    }
                  } catch (e) {
                    // Skip invalid URLs
                  }
                }
              }
              
              if (searchResults.length > 0) {
                console.log('✅ Search successful with proxy:', proxyUrl);
                break; // Exit loop if successful
              }
            }
          } catch (proxyError) {
            const errorMessage = proxyError instanceof Error ? proxyError.message : 'Unknown error';
            console.log('❌ Proxy failed:', proxyUrl, errorMessage);
            continue; // Try next proxy
          }
        }
        
        // Fallback results if search fails
        if (searchResults.length === 0) {
          searchResults = [
            {
              title: `${prompt} - Wikipedia Indonesia`,  
              snippet: `Artikel lengkap tentang ${prompt} dengan informasi mendalam dari berbagai sumber terpercaya.`,
              url: `https://id.wikipedia.org/wiki/${encodeURIComponent(prompt.replace(/\s+/g, '_'))}`
            },
            {
              title: `${prompt} - Google Search`,
              snippet: `Hasil pencarian terkini untuk ${prompt} dari berbagai sumber di internet.`,
              url: `https://www.google.com/search?q=${encodeURIComponent(prompt)}`
            },
            {
              title: `${prompt} - DuckDuckGo`,
              snippet: `Informasi tentang ${prompt} tersedia di berbagai sumber online.`,
              url: `https://duckduckgo.com/?q=${encodeURIComponent(prompt)}`
            },
            {
              title: `${prompt} - Bing Search`,
              snippet: `Temukan informasi terbaru tentang ${prompt} dari mesin pencari Bing.`,
              url: `https://www.bing.com/search?q=${encodeURIComponent(prompt)}`
            }
          ];
        }
        
        console.log('Search results provided:', searchResults.length);
        
        return new Response(JSON.stringify({ results: searchResults }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        
      } catch (searchError) {
        console.error('Search error:', searchError);
        
        // Always provide some results
        const basicResults = [{
          title: `Pencarian: ${prompt}`,
          snippet: `Informasi tentang "${prompt}" tersedia di berbagai sumber online. Coba pencarian dengan kata kunci yang lebih spesifik.`,
          url: `https://duckduckgo.com/?q=${encodeURIComponent(prompt)}`
        }];
        
        return new Response(JSON.stringify({ 
          results: basicResults
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Handle web scraping functionality
    if (action === 'web') {
      console.log('Performing web scraping for URL:', requestBody.url);
      
      try {
        const targetUrl = requestBody.url;
        if (!targetUrl) {
          throw new Error('URL is required for web scraping');
        }
        
        // Generic web scraping using multiple CORS proxies
        const proxies = [
          'https://corsproxy.io/?',
          'https://api.codetabs.com/v1/proxy?quest=',
          'https://thingproxy.freeboard.io/fetch/'
        ];
        
        let textContent = '';
        
        for (const proxyUrl of proxies) {
          try {
            const fullUrl = proxyUrl + encodeURIComponent(targetUrl);
            
            console.log('🌐 Trying web fetch with proxy:', proxyUrl);
            
            // Add timeout and better error handling
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout
            
            const webResponse = await fetch(fullUrl, {
              signal: controller.signal,
              headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; EdgeFunction/1.0)'
              }
            });
            
            clearTimeout(timeoutId);
            
            if (!webResponse.ok) {
              throw new Error(`HTTP ${webResponse.status}: ${webResponse.statusText}`);
            }
            
            const data = proxyUrl.includes('allorigins') ? 
              await webResponse.json().then(d => d.contents) : 
              await webResponse.text();
            
            if (!data) {
              throw new Error('No content returned from proxy');
            }
        
        // Extract text content from HTML with improved parsing
        const cleanHtml = data
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '') // Remove navigation
          .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '') // Remove headers
          .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '') // Remove footers
          .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '') // Remove sidebars
          .replace(/<!--[\s\S]*?-->/gi, '') // Remove comments
          .replace(/<[^>]+>/g, ' ') // Remove HTML tags
          .replace(/\s+/g, ' ') // Normalize whitespace
          .replace(/\t/g, ' ') // Replace tabs
          .trim();
        
        textContent = cleanHtml.substring(0, 8000); // Limit content length
        
        if (textContent && textContent.length >= 50) {
          console.log('✅ Web content extracted successfully with proxy:', proxyUrl);
          break; // Exit loop if successful
        }
      } catch (proxyError) {
        const errorMessage = proxyError instanceof Error ? proxyError.message : 'Unknown error';
        console.log('❌ Web proxy failed:', proxyUrl, errorMessage);
        continue; // Try next proxy
      }
    }
        
        if (!textContent || textContent.length < 50) {
          throw new Error('No meaningful content extracted from webpage');
        }
        
        console.log('Web content extracted, length:', textContent.length);
        
        return new Response(JSON.stringify({ 
          content: textContent,
          url: targetUrl 
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
        
      } catch (webError) {
        console.error('Web scraping error:', webError);
        
        // More specific error messages
        let errorMessage = 'Gagal mengakses konten web';
        if (webError instanceof Error) {
          if (webError.name === 'AbortError') {
            errorMessage = 'Request timeout - website terlalu lama merespons';
          } else if (webError.message.includes('HTTP')) {
            errorMessage = `Website error: ${webError.message}`;
          } else if (webError.message.includes('fetch')) {
            errorMessage = 'Tidak dapat mengakses website - periksa URL';
          }
          
          return new Response(JSON.stringify({ 
            error: `${errorMessage}: ${webError.message}` 
          }), {
            status: 400,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
        
        return new Response(JSON.stringify({ 
          error: errorMessage
        }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
    }
    
    // Handle vision model functionality with direct prompt
    if (action === 'generate' && image) {
      console.log('🖼️ Processing vision request with model:', model);
      
      if (!prompt) {
        return new Response(
          JSON.stringify({ error: 'Prompt is required for vision' }),
          { 
            status: 400, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }

      // Always use qwen3-vl:235b-cloud for vision
      const visionModel = 'qwen3-vl:235b-cloud';
      console.log(`Making vision request to Ollama Cloud API with model: ${visionModel}`);
      
      // Extract base64 data from data URL
      const base64Data = image.split(',')[1] || image;
      
      // Use user's prompt directly - no RAG processing
      const visionPrompt = prompt;

      try {
        const response = await fetch('https://ollama.com/api/chat', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ollamaApiKey}`
          },
          body: JSON.stringify({
            model: visionModel,
            messages: [
              {
                role: 'user',
                content: visionPrompt,
                images: [base64Data]
              }
            ],
            stream: true,
            options: {
              temperature: 0.1,
              top_p: 0.9
            }
          }),
        });

        if (!response.ok) {
          console.error(`Ollama Vision API error: ${response.status} ${response.statusText}`);
          const errorText = await response.text();
          console.error('Error response:', errorText);
          return new Response(
            JSON.stringify({ 
              error: `Ollama Vision API error: ${response.status} - ${errorText}` 
            }),
            { 
              status: 500, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
          );
        }

        // Collect the full response from the stream
        const reader = response.body?.getReader();
        if (!reader) {
          return new Response(
            JSON.stringify({ error: 'No response stream' }),
            { 
              status: 500, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
            }
          );
        }

        const decoder = new TextDecoder();
        let fullResponse = '';
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            
            if (done) break;

            const chunk = decoder.decode(value);
            buffer += chunk;
            
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              if (line.trim()) {
                try {
                  const data = JSON.parse(line.trim());
                  
                  // Accumulate response content
                  if (data.message?.content) {
                    fullResponse += data.message.content;
                  }
                  
                  if (data.done) {
                    console.log('Vision response completed from Ollama Cloud');
                    break;
                  }
                } catch (e) {
                  const errorMessage = e instanceof Error ? e.message : 'Unknown error';
                  console.log('JSON parse error for vision line:', line, 'Error:', errorMessage);
                  continue;
                }
              }
            }
          }
        } catch (error) {
          console.error('Vision stream error:', error);
          return new Response(
            JSON.stringify({ 
              error: 'Vision stream error occurred' 
            }),
            { 
              status: 500, 
              headers: { ...corsHeaders, 'Content-Type': 'application/json' }
            }
          );
        }

        // Return the complete response as JSON
        return new Response(
          JSON.stringify({ 
            response: fullResponse 
          }),
          {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }
          }
        );
      } catch (fetchError) {
        console.error('Fetch error for vision:', fetchError);
        const errorMessage = fetchError instanceof Error ? fetchError.message : 'Unknown error';
        return new Response(
          JSON.stringify({ 
            error: `Network error connecting to Ollama: ${errorMessage}` 
          }),
          { 
            status: 500, 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
          }
        );
      }
    }
    
    // Handle Ollama chat functionality with streaming support
    if (!prompt) {
      return new Response(
        JSON.stringify({ error: 'Prompt is required' }),
        { 
          status: 400, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    console.log(`Making request to Ollama Cloud API`);
    
    // Get chat history from request body  
    const { history } = requestBody;
    
    // Prepare messages array for chat API
    type ChatMessage = {
      role: 'user' | 'assistant' | 'system';
      content: string;
      images?: string[];
    };
    
    let chatMessages: ChatMessage[] = [];
    
    // Add history if available
    if (history && Array.isArray(history) && history.length > 0) {
      chatMessages = [...history];
    }
    
    // Add the current user message
    chatMessages.push({
      role: 'user',
      content: prompt
    });
    
    // Ensure cloud model has -cloud suffix if not already present
    let cloudModel = model;
    if (!model.endsWith('-cloud')) {
      cloudModel = `${model}-cloud`;
      console.log(`⚠️ Model name adjusted for cloud: ${model} -> ${cloudModel}`);
    }
    
    console.log(`📝 Sending to Ollama Cloud: ${chatMessages.length} messages, model: ${cloudModel}`);
    
    const response = await fetch('https://ollama.com/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ollamaApiKey}`
      },
      body: JSON.stringify({
        model: cloudModel,
        messages: chatMessages,
        stream: stream,  // Use stream parameter from request
      }),
    });

    if (!response.ok) {
      console.error(`Ollama API error: ${response.status} ${response.statusText}`);
      const errorText = await response.text();
      console.error('Ollama error response:', errorText);
      
      // Provide helpful error messages
      let errorMessage = `Ollama API error: ${response.status}`;
      if (response.status === 502) {
        errorMessage = 'Model tidak tersedia atau sedang bermasalah. Pastikan model cloud tersedia.';
      } else if (response.status === 401) {
        errorMessage = 'API key tidak valid. Periksa OLLAMA_API_KEY.';
      } else if (response.status === 404) {
        errorMessage = `Model "${cloudModel}" tidak ditemukan. Gunakan model cloud yang valid.`;
      }
      
      return new Response(
        JSON.stringify({ 
          error: errorMessage,
          details: errorText
        }),
        { 
          status: response.status, 
          headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
        }
      );
    }

    // Handle streaming vs non-streaming response
    if (stream) {
      // Stream the response directly from Ollama
      console.log('✅ Streaming response from Ollama Cloud - passing through response body');
      console.log('Response headers:', {
        contentType: response.headers.get('content-type'),
        status: response.status,
        ok: response.ok
      });
      
      // Pass through the response body directly
      return new Response(response.body, {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/x-ndjson',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        },
      });
    } else {
      // Non-streaming: collect full response and return as JSON
      console.log('📦 Collecting non-streaming response from Ollama Cloud');
      const data = await response.json();
      
      // Ollama Cloud non-streaming format: { "model": "...", "message": { "role": "assistant", "content": "..." }, "done": true }
      const fullResponse = data.message?.content || '';
      console.log('✅ Got non-streaming response, length:', fullResponse.length);
      
      return new Response(
        JSON.stringify({ response: fullResponse }),
        {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        }
      );
    }

  } catch (error) {
    console.error('Error in ollama-proxy:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(
      JSON.stringify({ 
        error: `Failed to connect to Ollama: ${errorMessage}` 
      }),
      { 
        status: 500, 
        headers: { ...corsHeaders, 'Content-Type': 'application/json' } 
      }
    );
  }
})
