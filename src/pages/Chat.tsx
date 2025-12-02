import { useState, useEffect } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ChatSidebar } from "@/components/chat/ChatSidebar";
import { ChatMessage } from "@/components/chat/ChatMessage";
import { ChatInput } from "@/components/chat/ChatInput";
import { TypingIndicator } from "@/components/chat/TypingIndicator";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Menu, LogOut, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import { searchAndFetchContent, getWebpageContent } from "@/utils/ragUtils";
import { ModelSelector } from "@/components/chat/ModelSelector";
import { useSelectedModel } from "@/contexts/ModelContext";
import { supabase } from "@/integrations/supabase/client";
import firefliesLogo from "@/assets/fireflies-logo.png";
import { useChatHistory, type ChatMessage as HistoryMessage } from "@/hooks/useChatHistory";

export const Chat = () => {
  const { toast } = useToast();
  const { profile, signOut, checkSubscription } = useAuth();
  const { selectedModel } = useSelectedModel();
  const {
    chatSessions,
    currentChatId,
    loading,
    setCurrentChatId,
    createNewChatSession,
    saveMessage,
    updateChatTitle,
    deleteChatSession,
    getCurrentChatMessages,
    getChatHistoryForAI,
    updateMessageContent,
    addMessageToLocal,
    generateUniqueId
  } = useChatHistory();
  
  console.log('🔄 Current selected model from hook:', selectedModel);
  
  const [isTyping, setIsTyping] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [hasStartedChatting, setHasStartedChatting] = useState(false);

  // Prevent streaming from pausing when tab becomes hidden
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Override the default behavior that pauses requests when tab is hidden
      if (document.hidden) {
        console.log('Tab hidden - keeping streams active');
      } else {
        console.log('Tab visible - streams continue normally');
      }
    };

    // Prevent automatic throttling of background tabs
    const preventThrottling = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      const renderLoop = () => {
        if (ctx) {
          ctx.clearRect(0, 0, 1, 1);
        }
        requestAnimationFrame(renderLoop);
      };
      renderLoop();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    preventThrottling();
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  // Get current messages from chat history
  const messages = getCurrentChatMessages();

  // Search RAG using Ollama native tool calling
  const handleSearchRAG = async (query: string, messageId: string, chatId: string) => {
    try {
      console.log('🔍 Starting Ollama native tool search for:', query);
      
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: query,
          model: selectedModel,
          useTools: true,
          messages: [
            {
              role: 'system',
              content: 'Kamu adalah asisten AI yang membantu mencari informasi di internet. Gunakan tool webSearch untuk mencari informasi yang relevan, kemudian gunakan webFetch untuk membaca konten website. Jawab dalam Bahasa Indonesia dengan informasi yang akurat.'
            },
            {
              role: 'user',
              content: query
            }
          ]
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start stream');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let isThinking = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('✅ Stream completed');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            
            if (parsed.type === 'thinking') {
              if (!isThinking) {
                isThinking = true;
                fullContent += '💭 **Berpikir...**\n\n';
              }
              // Don't show thinking content to user
            } else if (parsed.type === 'content') {
              if (isThinking) {
                isThinking = false;
                fullContent += '\n\n';
              }
              fullContent += parsed.content;
              updateMessageContent(messageId, fullContent);
            } else if (parsed.type === 'tool_call') {
              const toolInfo = `\n\n🔧 Menggunakan ${parsed.function}...\n`;
              fullContent += toolInfo;
              updateMessageContent(messageId, fullContent);
            } else if (parsed.type === 'error') {
              fullContent += `\n\n❌ Error: ${parsed.content}`;
              updateMessageContent(messageId, fullContent);
            }
          } catch (e) {
            console.error('Error parsing SSE:', e);
          }
        }
      }

      // Save final message
      await saveMessage(chatId, fullContent, 'assistant');
      
    } catch (error) {
      console.error('Error in search RAG:', error);
      const errorMsg = 'Maaf, terjadi kesalahan saat mencari informasi.';
      updateMessageContent(messageId, errorMsg);
      await saveMessage(chatId, errorMsg, 'assistant');
    }
  };

  // Web RAG using Ollama native tool calling
  const handleWebRAG = async (query: string, url: string, messageId: string, chatId: string) => {
    try {
      console.log('🌐 Starting Ollama native web fetch for:', url);
      
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: `${query} - URL: ${url}`,
          model: selectedModel,
          useTools: true,
          messages: [
            {
              role: 'system',
              content: 'Kamu adalah asisten AI yang membantu menganalisis konten website. Gunakan tool webFetch untuk membaca konten dari URL yang diberikan, kemudian jawab pertanyaan pengguna berdasarkan konten tersebut. Jawab dalam Bahasa Indonesia dengan informasi yang akurat.'
            },
            {
              role: 'user',
              content: `Baca konten dari ${url} dan jawab: ${query}`
            }
          ]
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start stream');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';
      let isThinking = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('✅ Stream completed');
            fullContent += `\n\n🌐 **Sumber:** ${url}`;
            updateMessageContent(messageId, fullContent);
            await saveMessage(chatId, fullContent, 'assistant');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            
            if (parsed.type === 'thinking') {
              if (!isThinking) {
                isThinking = true;
                fullContent += '💭 **Menganalisis...**\n\n';
              }
            } else if (parsed.type === 'content') {
              if (isThinking) {
                isThinking = false;
                fullContent += '\n\n';
              }
              fullContent += parsed.content;
              updateMessageContent(messageId, fullContent);
            } else if (parsed.type === 'tool_call') {
              const toolInfo = `\n\n🔧 Membaca konten dari ${parsed.arguments?.url || url}...\n`;
              fullContent += toolInfo;
              updateMessageContent(messageId, fullContent);
            } else if (parsed.type === 'error') {
              fullContent += `\n\n❌ Error: ${parsed.content}`;
              updateMessageContent(messageId, fullContent);
            }
          } catch (e) {
            console.error('Error parsing SSE:', e);
          }
        }
      }

      await saveMessage(chatId, fullContent, 'assistant');
      
    } catch (error) {
      console.error('Error in web RAG:', error);
      const errorMsg = 'Maaf, terjadi kesalahan saat memproses konten web.';
      updateMessageContent(messageId, errorMsg);
      await saveMessage(chatId, errorMsg, 'assistant');
    }
  };

  // Document RAG - Parse document and analyze with AI
  const handleDocumentRAG = async (query: string, base64Document: string, fileName: string, fileType: string, messageId: string, chatId: string) => {
    try {
      console.log('📄 Starting document processing for:', fileName);
      
      // Determine action based on file type
      let action = 'parse-pdf';
      if (fileType.includes('word') || fileType.includes('document')) {
        action = 'parse-word';
      } else if (fileType.includes('spreadsheet') || fileType.includes('excel')) {
        action = 'parse-excel';
      }
      
      updateMessageContent(messageId, `📄 Membaca dokumen ${fileName}...`);
      
      // Call document processor edge function
      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      
      const parseResponse = await fetch(`${SUPABASE_URL}/functions/v1/document-processor`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          action,
          fileData: base64Document,
          fileName,
          fileType
        }),
      });
      
      const parsedData = await parseResponse.json();
      
      // Handle Word document warning (422 status)
      if (parseResponse.status === 422 && action === 'parse-word') {
        const warningMsg = `⚠️ **Format dokumen Word tidak sepenuhnya didukung**\n\n${parsedData.suggestion || 'Silakan convert dokumen ke PDF untuk hasil terbaik.'}\n\nApakah Anda ingin saya bantu dengan cara lain?`;
        updateMessageContent(messageId, warningMsg);
        await saveMessage(chatId, warningMsg, 'assistant');
        return;
      }
      
      if (!parseResponse.ok) {
        throw new Error(parsedData.error || 'Failed to parse document');
      }
      
      console.log('✅ Document parsed successfully');
      
      // Extract text from parsed data
      let documentText = '';
      if (parsedData.text) {
        documentText = parsedData.text;
      } else if (parsedData.sheets) {
        // For Excel, combine all sheets
        documentText = Object.entries(parsedData.sheets)
          .map(([sheetName, data]: [string, any]) => {
            return `Sheet: ${sheetName}\n${JSON.stringify(data, null, 2)}`;
          })
          .join('\n\n');
      }
      
      if (!documentText || documentText.length < 10) {
        throw new Error('No meaningful text extracted from document');
      }
      
      updateMessageContent(messageId, `📄 Menganalisis konten dokumen (${documentText.length} karakter)...`);
      
      // Truncate if too long (keep first 15000 chars)
      const truncatedText = documentText.substring(0, 15000);
      if (documentText.length > 15000) {
        console.log(`⚠️ Document truncated from ${documentText.length} to 15000 characters`);
      }
      
      // Now send to AI with the extracted text
      const response = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${SUPABASE_KEY}`,
        },
        body: JSON.stringify({
          prompt: `Dokumen: ${fileName}\n\nIsi dokumen:\n${truncatedText}\n\nPertanyaan: ${query}`,
          model: selectedModel,
          useTools: false,
          messages: [
            {
              role: 'system',
              content: 'Kamu adalah asisten AI yang membantu menganalisis dokumen. Berikan jawaban yang akurat dan jelas dalam Bahasa Indonesia berdasarkan isi dokumen.'
            },
            {
              role: 'user',
              content: `Dokumen: ${fileName}\n\nIsi dokumen:\n${truncatedText}\n\nPertanyaan: ${query}`
            }
          ]
        }),
      });

      if (!response.ok || !response.body) {
        throw new Error('Failed to start AI stream');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let fullContent = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const data = line.slice(6);
          if (data === '[DONE]') {
            console.log('✅ Stream completed');
            fullContent += `\n\n📄 **Dokumen:** ${fileName} (${Math.round(documentText.length / 1000)}KB text)`;
            updateMessageContent(messageId, fullContent);
            await saveMessage(chatId, fullContent, 'assistant');
            return;
          }

          try {
            const parsed = JSON.parse(data);
            
            if (parsed.type === 'content') {
              fullContent += parsed.content;
              updateMessageContent(messageId, fullContent);
            } else if (parsed.type === 'error') {
              fullContent += `\n\n❌ Error: ${parsed.content}`;
              updateMessageContent(messageId, fullContent);
            }
          } catch (e) {
            console.error('Error parsing SSE:', e);
          }
        }
      }

      await saveMessage(chatId, fullContent, 'assistant');
      
    } catch (error) {
      console.error('Error in document RAG:', error);
      const errorMsg = `Maaf, terjadi kesalahan saat memproses dokumen: ${error instanceof Error ? error.message : 'Unknown error'}\n\n💡 **Tips:**\n- Pastikan dokumen tidak rusak\n- Coba convert ke PDF jika format Word\n- Ukuran file maksimal 10MB`;
      updateMessageContent(messageId, errorMsg);
      await saveMessage(chatId, errorMsg, 'assistant');
    }
  };

  const handleStopGeneration = () => {
    if (abortController) {
      console.log('🛑 Stopping generation...');
      abortController.abort();
      setAbortController(null);
      setIsGenerating(false);
      setIsTyping(false);
      
      toast({
        title: "Generation Stopped",
        description: "Response generation has been stopped.",
      });
    }
  };

  const handleSendMessage = async (content: string, image?: File, document?: File) => {
    console.log('🤖 Using model:', selectedModel);
    
    // Check if user has subscription or is on free plan
    if (!profile) {
      toast({
        title: "Authentication Required",
        description: "Please log in to use the chat.",
        variant: "destructive",
      });
      return;
    }

    // Handle image uploads - automatically switch to vision model
    let finalContent = content;
    let targetModel = selectedModel;
    let base64Image = null;
    
    if (image) {
      targetModel = "qwen3-vl:235b-cloud"; // Vision model
      console.log('🖼️ Image detected, switching to vision model:', targetModel);
      
      // Convert image to base64
      base64Image = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.readAsDataURL(image);
      });
      
      finalContent = content || "Describe this image in detail in Indonesian language.";
      console.log('🖼️ Image converted to base64, length:', base64Image.length);
    }

    // Handle document uploads
    let base64Document = null;
    let documentFileName = '';
    let documentType = '';
    
    if (document) {
      console.log('📄 Document detected:', document.name, document.type);
      documentFileName = document.name;
      documentType = document.type;
      
      // Convert document to base64
      base64Document = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onload = () => {
          const base64 = (reader.result as string).split(',')[1];
          resolve(base64);
        };
        reader.readAsDataURL(document);
      });
      
      console.log('📄 Document converted to base64, length:', base64Document.length);
    }

    // Ensure we have a current chat session
    let activeChatId = currentChatId;
    if (!activeChatId) {
      const title = finalContent.length > 50 ? finalContent.substring(0, 50) + "..." : finalContent;
      activeChatId = await createNewChatSession(title);
      if (!activeChatId) return;
    }

    const userMessage: HistoryMessage = {
      id: generateUniqueId(),
      content: finalContent,
      role: 'user',
      timestamp: new Date()
    };

    // Add message to local state immediately for UI responsiveness
    addMessageToLocal(activeChatId, userMessage);
    
    // Save user message to database
    await saveMessage(activeChatId, finalContent, 'user');
    
    // Update chat title if this is the first message
    if (!hasStartedChatting) {
      const title = finalContent.length > 50 ? finalContent.substring(0, 50) + "..." : finalContent;
      await updateChatTitle(activeChatId, title);
      setHasStartedChatting(true);
      setSidebarOpen(false);
    }

    setIsTyping(true);

    try {
      let finalResponse = '';
      
      // Check for RAG commands
      if (finalContent.toLowerCase().startsWith('/cari ')) {
        const query = finalContent.substring(6).trim();
        if (query) {
          const aiMessageId = generateUniqueId();
          const aiMessage: HistoryMessage = {
            id: aiMessageId,
            content: '🔍 Mencari informasi...',
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          setIsTyping(false);
          
          await handleSearchRAG(query, aiMessageId, activeChatId);
        } else {
          finalResponse = 'Mohon masukkan kata kunci pencarian setelah /cari';
          const aiMessage: HistoryMessage = {
            id: generateUniqueId(),
            content: finalResponse,
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          await saveMessage(activeChatId, finalResponse, 'assistant');
          setIsTyping(false);
        }
        return;
      }
      
      else if (finalContent.toLowerCase().startsWith('/web ')) {
        const content = finalContent.substring(5).trim();
        // Parse the web command: /web question url
        const urlRegex = /(https?:\/\/[^\s]+)/i;
        const urlMatch = content.match(urlRegex);
        
        if (urlMatch) {
          const url = urlMatch[0];
          const question = content.replace(url, '').trim();
          
          if (question) {
            const aiMessageId = generateUniqueId();
            const aiMessage: HistoryMessage = {
              id: aiMessageId,
              content: '🌐 Membaca konten website...',
              role: 'assistant',
              timestamp: new Date()
            };
            addMessageToLocal(activeChatId, aiMessage);
            setIsTyping(false);
            
            await handleWebRAG(question, url, aiMessageId, activeChatId);
          } else {
            finalResponse = 'Mohon masukkan pertanyaan sebelum URL. Contoh: /web ambil fungsi yang ada di web https://example.com';
            const aiMessage: HistoryMessage = {
              id: generateUniqueId(),
              content: finalResponse,
              role: 'assistant',
              timestamp: new Date()
            };
            addMessageToLocal(activeChatId, aiMessage);
            await saveMessage(activeChatId, finalResponse, 'assistant');
            setIsTyping(false);
          }
        } else {
          finalResponse = 'Mohon masukkan URL yang valid. Contoh: /web ambil fungsi yang ada di web https://example.com';
          const aiMessage: HistoryMessage = {
            id: generateUniqueId(),
            content: finalResponse,
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          await saveMessage(activeChatId, finalResponse, 'assistant');
          setIsTyping(false);
        }
        return;
      }
      
      else if (finalContent.toLowerCase().startsWith('/dokumen ') || base64Document) {
        if (!base64Document) {
          finalResponse = 'Mohon upload dokumen terlebih dahulu dengan memilih tool "Baca Dokumen"';
          const aiMessage: HistoryMessage = {
            id: generateUniqueId(),
            content: finalResponse,
            role: 'assistant',
            timestamp: new Date()
          };
          addMessageToLocal(activeChatId, aiMessage);
          await saveMessage(activeChatId, finalResponse, 'assistant');
          setIsTyping(false);
          return;
        }
        
        const query = finalContent.toLowerCase().startsWith('/dokumen ') 
          ? finalContent.substring(9).trim()
          : finalContent.trim() || 'Baca dan ringkas dokumen ini';
        
        const aiMessageId = generateUniqueId();
        const aiMessage: HistoryMessage = {
          id: aiMessageId,
          content: `📄 Memproses dokumen ${documentFileName}...`,
          role: 'assistant',
          timestamp: new Date()
        };
        addMessageToLocal(activeChatId, aiMessage);
        setIsTyping(false);
        
        await handleDocumentRAG(query, base64Document, documentFileName, documentType, aiMessageId, activeChatId);
        return;
      }

      // Regular chat - Call Ollama via Edge Function
      try {
        setIsGenerating(true);
        
        // Create abort controller for stopping generation
        const controller = new AbortController();
        setAbortController(controller);
        
        // Create initial AI message
        const aiMessageId = generateUniqueId();
        const aiMessage: HistoryMessage = {
          id: aiMessageId,
          content: '',
          role: 'assistant',
          timestamp: new Date()
        };
        
        addMessageToLocal(activeChatId, aiMessage);
        setIsTyping(false);

        // For vision models, use direct prompt mode; for text models, use chat mode
        const useDirectPrompt = base64Image !== null;
        
        let response: Response;
        let responseData;
        let fullResponse = '';
        
        if (useDirectPrompt) {
          console.log('🤖 Using direct prompt mode for vision model:', targetModel);
          // Direct prompt mode for vision
          const { data, error } = await supabase.functions.invoke('ollama-proxy', {
            body: { 
              action: 'generate',
              model: targetModel,
              prompt: finalContent,
              image: base64Image?.split(',')[1] || base64Image
            }
          });
          
          if (error) {
            throw new Error(`Edge Function error: ${error.message}`);
          }
          responseData = data;
          
          // Handle vision response (non-streaming)
          if (responseData && responseData.response) {
            fullResponse = responseData.response;
            updateMessageContent(aiMessageId, fullResponse);
          }
        } else {
          // Get chat history for AI context
          const chatHistory = getChatHistoryForAI(activeChatId);

          // Chat mode for text models - use streaming
          console.log('🤖 Using chat mode with streaming for text model:', targetModel);
          
          // Use direct fetch for streaming support
          const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
          const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
          
          const streamResponse = await fetch(`${SUPABASE_URL}/functions/v1/ollama-proxy`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${SUPABASE_KEY}`,
            },
            body: JSON.stringify({
              prompt: finalContent,
              model: targetModel,
              history: chatHistory.map(msg => ({
                role: msg.role,
                content: msg.content
              }))
            }),
            signal: controller.signal,
          });
          
          if (!streamResponse.ok) {
            throw new Error(`Streaming error: ${streamResponse.status}`);
          }
          
          // Handle streaming response
          const reader = streamResponse.body?.getReader();
          const decoder = new TextDecoder();
          
          if (!reader) {
            throw new Error('No stream reader available');
          }
          
          let buffer = '';
          let isDone = false;
          
          console.log('🚀 Starting to read stream...');
          
          while (!isDone) {
            const { done, value } = await reader.read();
            
            if (done) {
              console.log('📡 Stream reader finished, total response length:', fullResponse.length);
              break;
            }
            
            const chunk = decoder.decode(value, { stream: true });
            console.log('📦 Received chunk, size:', chunk.length);
            buffer += chunk;
            
            // Split by newlines to process complete JSON objects
            const lines = buffer.split('\n');
            // Keep the last incomplete line in the buffer
            buffer = lines.pop() || '';
            
            for (const line of lines) {
              const trimmedLine = line.trim();
              if (!trimmedLine) continue;
              
              try {
                const data = JSON.parse(trimmedLine);
                console.log('📨 Parsed data:', { 
                  hasMessage: !!data.message, 
                  hasContent: !!data.message?.content,
                  contentLength: data.message?.content?.length || 0,
                  done: data.done 
                });
                
                // Ollama Cloud streaming format
                if (data.message?.content && data.message.content.length > 0) {
                  const newContent = data.message.content;
                  fullResponse += newContent;
                  console.log('✍️ Added content, total length now:', fullResponse.length);
                  
                  // Update UI in real-time
                  updateMessageContent(aiMessageId, fullResponse);
                }
                
                // Check if streaming is complete
                if (data.done === true) {
                  console.log('✅ Streaming marked as done, final length:', fullResponse.length);
                  isDone = true;
                  break;
                }
              } catch (e) {
                // Log parsing errors for debugging
                if (trimmedLine.length > 0) {
                  console.error('❌ Failed to parse JSON line:', {
                    lineStart: trimmedLine.substring(0, 100),
                    error: e instanceof Error ? e.message : 'Unknown error'
                  });
                }
              }
            }
          }
          
          // Process any remaining buffer
          if (buffer.trim()) {
            try {
              const data = JSON.parse(buffer.trim());
              if (data.message?.content && data.message.content.length > 0) {
                fullResponse += data.message.content;
                console.log('📝 Added final buffer content, total length:', fullResponse.length);
                updateMessageContent(aiMessageId, fullResponse);
              }
            } catch (e) {
              console.error('❌ Failed to parse final buffer:', e);
            }
          }
          
          console.log('🏁 Stream processing complete. Final response length:', fullResponse.length);
          
          // Ensure we have some response
          if (!fullResponse || fullResponse.trim().length === 0) {
            console.error('❌ Empty response received from AI');
            throw new Error('AI tidak memberikan respons. Ini mungkin karena:\n1. Konten tidak relevan dengan model\n2. Server AI sedang sibuk\n3. Model perlu restart\n\nSilakan coba lagi atau gunakan model lain.');
          }
          
          console.log('✅ Successfully received response, length:', fullResponse.length);
        }

        // Save the complete AI response to database
        if (fullResponse) {
          await saveMessage(activeChatId, fullResponse, 'assistant');
        }

        // No credit deduction needed - subscription based
      } catch (fetchError) {
        console.error('🔴 Edge Function error:', fetchError);
        
        // Show user-friendly error message
        let errorMsg = 'Tidak dapat terhubung ke AI. ';
        if (fetchError.message.includes('502')) {
          errorMsg += 'Server AI sedang bermasalah. Silakan coba lagi dalam beberapa saat.';
        } else if (fetchError.message.includes('timeout')) {
          errorMsg += 'Koneksi timeout. Silakan coba lagi.';
        } else if (fetchError.message.includes('tidak ada respons')) {
          errorMsg += 'AI tidak memberikan respons. Silakan coba lagi.';
        } else {
          errorMsg += 'Silakan coba lagi atau gunakan /cari [query] untuk pencarian web.';
        }
        
        toast({
          title: "Error",
          description: errorMsg,
          variant: "destructive"
        });
      } finally {
        setIsGenerating(false);
        setAbortController(null);
      }
    } catch (error) {
      console.error('Error calling Ollama API:', error);
      const activeChatIdForError = currentChatId || await createNewChatSession("Error");
      if (activeChatIdForError) {
        const errorMessage: HistoryMessage = {
          id: generateUniqueId(),
          content: `❌ Maaf, API LLM sedang mengalami error.

💡 **Alternative:** Use /cari [query] for web search instead!`,
          role: 'assistant',
          timestamp: new Date()
        };
        addMessageToLocal(activeChatIdForError, errorMessage);
        await saveMessage(activeChatIdForError, errorMessage.content, 'assistant');
      }
      setIsTyping(false);
    }
  };

  const handleNewChat = async () => {
    const newChatId = await createNewChatSession("New Chat");
    if (newChatId) {
      setHasStartedChatting(false);
      setSidebarOpen(false);
    }
  };

  const handleSelectChat = (chatId: string) => {
    setCurrentChatId(chatId);
    const selectedChat = chatSessions.find(chat => chat.id === chatId);
    setHasStartedChatting(selectedChat ? selectedChat.messages.length > 0 : false);
    setSidebarOpen(false);
  };

  const handleEditChat = async (chatId: string, newTitle: string) => {
    await updateChatTitle(chatId, newTitle);
  };

  const handleDeleteChat = async (chatId: string) => {
    await deleteChatSession(chatId);
    // If we deleted the current chat, create a new one
    if (currentChatId === chatId) {
      await handleNewChat();
    }
  };

  const stopGeneration = async () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsGenerating(false);
      setIsTyping(false);
      
      // Add a message indicating that generation was stopped
      const activeChatIdForStop = currentChatId || await createNewChatSession("Stopped");
      if (activeChatIdForStop) {
        const stopMessage: HistoryMessage = {
          id: generateUniqueId(),
          content: "🛑 **Generation stopped by user**",
          role: 'assistant',
          timestamp: new Date()
        };
        
        addMessageToLocal(activeChatIdForStop, stopMessage);
        await saveMessage(activeChatIdForStop, stopMessage.content, 'assistant');
      }
    }
  };

  const handleToolUse = async (tool: 'search' | 'web' | 'document', query: string, document?: File) => {
    // This function is now mostly for legacy support
    // The main RAG functionality is handled in handleSendMessage
    toast({
      title: "Info",
      description: "Gunakan perintah /cari atau /web di chat untuk menggunakan alat RAG",
    });
  };

  if (!profile) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <h2 className="text-xl font-semibold mb-2">Please log in to continue</h2>
          <Button onClick={() => window.location.href = '/auth'}>
            Go to Login
          </Button>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
          <p>Loading chat history...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* Sidebar with proper mobile handling */}
      <div className={`
        ${sidebarOpen ? 'w-64' : 'w-0'} 
        transition-all duration-300 ease-in-out 
        bg-background border-r border-border 
        flex-shrink-0 overflow-hidden
        animate-slide-in
        lg:relative fixed lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        top-0 left-0 h-full z-50
      `}>
        <div className={`w-64 h-full ${sidebarOpen ? 'animate-fade-in' : 'animate-fade-out'}`}>
          <ChatSidebar
            currentChatId={currentChatId}
            onNewChat={handleNewChat}
            onSelectChat={handleSelectChat}
            onDeleteChat={handleDeleteChat}
            onEditChat={handleEditChat}
            chatSessions={chatSessions}
          />
        </div>
      </div>
      
      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/30 z-40 lg:hidden animate-fade-in"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      
      <div className="flex-1 flex flex-col">
        {/* Header */}
        <header className="border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
          <div className="flex items-center justify-between p-4">
            <div className="flex items-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="hover-scale transition-all duration-200 hover:bg-accent/50"
              >
                <Menu className="w-4 h-4" />
              </Button>
              <div className="flex items-center gap-2 animate-fade-in">
                <img src={firefliesLogo} alt="FireFlies" className="w-8 h-8 hover-scale" />
                <h1 className="text-xl font-semibold bg-gradient-to-r from-yellow-400 to-yellow-600 bg-clip-text text-transparent">
                  FireFlies
                </h1>
              </div>
            </div>
            
            <div className="flex items-center gap-4">
              {/* Subscription Display */}
              <div className="flex items-center gap-2 px-3 py-1.5 bg-primary/10 rounded-lg">
                <CreditCard className="w-4 h-4 text-primary" />
                <span className="text-sm font-medium">
                  {profile?.subscription_plan === 'pro' ? 'Pro Plan' : 'Free Plan'}
                </span>
              </div>
              
              {/* Upgrade Button for Free Users in Header */}
              {profile?.subscription_plan === 'free' && (
                <Button
                  onClick={() => window.open('/pricing', '_blank')}
                  variant="default"
                  size="sm"
                  className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
                >
                  Upgrade
                </Button>
              )}
              
              {/* Model Selector */}
              <ModelSelector />
              
              {/* User Info and Logout */}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {profile?.full_name || profile?.email || 'User'}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={signOut}
                  className="hover:bg-destructive/10 hover:text-destructive"
                >
                  <LogOut className="w-4 h-4" />
                </Button>
              </div>
              
              <ThemeToggle />
            </div>
          </div>
        </header>

        {/* Chat Area */}
        <div className="flex-1 flex flex-col overflow-hidden">
          <ScrollArea className="flex-1 h-full">
            <div className="max-w-4xl mx-auto p-4">
              {messages.length === 0 && (
                <div className="text-center py-12 px-6">
                  <div className="flex justify-center mb-6">
                    <img src={firefliesLogo} alt="Chat AI" className="w-20 h-20" />
                  </div>
                  <h2 className="text-3xl font-bold mb-4 text-foreground">
                    Welcome to AI Chat
                  </h2>
                  <p className="text-muted-foreground text-lg mb-8">
                    How can I help you today?
                  </p>
                  
                  {/* Upgrade Button for Free Users */}
                  {profile?.subscription_plan === 'free' && (
                    <div className="mb-8">
                      <Button
                        onClick={() => window.open('/pricing', '_blank')}
                        variant="default"
                        size="lg"
                        className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
                      >
                        Upgrade to Pro
                      </Button>
                    </div>
                  )}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 max-w-2xl mx-auto animate-fade-in">
                    {[
                      "Help me write a creative story",
                      "Explain a complex topic simply", 
                      "Code review and optimization",
                      "Plan my next vacation"
                    ].map((suggestion, index) => (
                      <button
                        key={index}
                        onClick={() => handleSendMessage(suggestion)}
                        className="p-4 text-left border border-border rounded-xl hover:bg-accent/50 transition-all duration-200 hover-scale animate-fade-in"
                        style={{ animationDelay: `${index * 100}ms` }}
                      >
                        <span className="text-sm font-medium">{suggestion}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              {messages.map((message) => (
                <ChatMessage key={message.id} message={message} />
              ))}
              
              {isTyping && <TypingIndicator />}
            </div>
          </ScrollArea>

          <ChatInput 
            onSendMessage={handleSendMessage}
            onToolUse={handleToolUse}
            onStopGeneration={handleStopGeneration}
            disabled={isTyping}
            isGenerating={isGenerating}
          />
        </div>
      </div>
    </div>
  );
};
