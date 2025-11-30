import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface ParseResult {
  success: boolean;
  content?: string;
  error?: string;
  metadata?: {
    filename: string;
    pages?: number;
    size: number;
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    console.log('📄 Document parser invoked');
    
    const formData = await req.formData();
    const file = formData.get('file') as File;
    
    if (!file) {
      return new Response(
        JSON.stringify({ success: false, error: 'No file provided' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    console.log(`📎 Processing file: ${file.name} (${file.type}, ${file.size} bytes)`);

    // Get file extension
    const ext = file.name.split('.').pop()?.toLowerCase() || '';
    
    // Convert file to buffer
    const buffer = await file.arrayBuffer();
    
    let content = '';
    
    // Handle different file types
    if (ext === 'txt' || ext === 'md') {
      // Plain text files
      content = new TextDecoder().decode(buffer);
    } else if (ext === 'csv') {
      // CSV files
      const text = new TextDecoder().decode(buffer);
      const lines = text.split('\n').slice(0, 100); // Limit to first 100 lines
      content = `CSV Data:\n\n${lines.join('\n')}`;
    } else if (ext === 'json') {
      // JSON files
      const text = new TextDecoder().decode(buffer);
      try {
        const json = JSON.parse(text);
        content = `JSON Data:\n\n${JSON.stringify(json, null, 2).slice(0, 10000)}`;
      } catch {
        content = text.slice(0, 10000);
      }
    } else if (['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt'].includes(ext)) {
      // For binary documents, we'll need to use an external service or library
      // For now, return metadata and instruct to use specialized tools
      const result: ParseResult = {
        success: false,
        error: `Format ${ext.toUpperCase()} membutuhkan parsing khusus. Fitur ini akan segera tersedia.`,
        metadata: {
          filename: file.name,
          size: file.size,
        }
      };
      
      return new Response(
        JSON.stringify(result),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      // Try to read as text
      try {
        content = new TextDecoder().decode(buffer);
      } catch {
        return new Response(
          JSON.stringify({ 
            success: false, 
            error: `Format file ${ext} tidak didukung atau tidak bisa dibaca sebagai text` 
          }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Limit content size
    if (content.length > 50000) {
      content = content.slice(0, 50000) + '\n\n[Konten dipotong karena terlalu panjang...]';
    }

    const result: ParseResult = {
      success: true,
      content,
      metadata: {
        filename: file.name,
        size: file.size,
      }
    };

    console.log(`✅ Successfully parsed ${file.name} (${content.length} characters)`);

    return new Response(
      JSON.stringify(result),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('❌ Document parser error:', error);
    return new Response(
      JSON.stringify({ 
        success: false, 
        error: error instanceof Error ? error.message : 'Unknown error' 
      }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
