import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { action, fileData, fileName, fileType } = await req.json();
    console.log(`📄 Document processor action: ${action}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    // Convert base64 to Uint8Array
    const binaryString = atob(fileData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }

    switch (action) {
      case 'parse-pdf': {
        try {
          // Use pdfjs-dist for PDF parsing (more Deno-compatible)
          const pdfjsLib = await import('https://esm.sh/pdfjs-dist@3.11.174/build/pdf.mjs');
          
          // Configure PDF.js
          const loadingTask = pdfjsLib.getDocument({
            data: bytes,
            useSystemFonts: true,
            verbosity: 0
          });
          
          const pdf = await loadingTask.promise;
          console.log(`✅ PDF loaded: ${pdf.numPages} pages`);
          
          let fullText = '';
          
          // Extract text from each page
          for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
            const page = await pdf.getPage(pageNum);
            const textContent = await page.getTextContent();
            const pageText = textContent.items
              .map((item: any) => item.str)
              .join(' ');
            fullText += `\n--- Page ${pageNum} ---\n${pageText}\n`;
          }
          
          console.log(`✅ PDF parsed: ${pdf.numPages} pages, ${fullText.length} characters`);
          
          return new Response(JSON.stringify({
            text: fullText,
            pages: pdf.numPages,
            info: { numPages: pdf.numPages }
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (pdfError) {
          console.error('PDF parsing error:', pdfError);
          // Fallback: return base64 for client-side processing
          return new Response(JSON.stringify({
            error: 'PDF parsing failed on server',
            suggestion: 'Client-side parsing recommended',
            fileData: fileData.substring(0, 100) + '...' // Preview
          }), {
            status: 422,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'parse-excel': {
        try {
          // SheetJS works well with Deno
          const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
          const workbook = XLSX.read(bytes, { type: 'array' });
          
          const sheets: Record<string, any[]> = {};
          workbook.SheetNames.forEach((sheetName: string) => {
            const worksheet = workbook.Sheets[sheetName];
            sheets[sheetName] = XLSX.utils.sheet_to_json(worksheet);
          });
          
          console.log(`✅ Excel parsed: ${workbook.SheetNames.length} sheets`);
          
          return new Response(JSON.stringify({
            sheets,
            sheetNames: workbook.SheetNames
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (excelError) {
          console.error('Excel parsing error:', excelError);
          return new Response(JSON.stringify({
            error: 'Excel parsing failed',
            details: excelError instanceof Error ? excelError.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'parse-word': {
        try {
          // Try using mammoth for Word document parsing
          const mammoth = await import('https://esm.sh/mammoth@1.6.0');
          
          const result = await mammoth.extractRawText({ 
            arrayBuffer: bytes.buffer 
          });
          
          const text = result.value;
          console.log(`✅ Word parsed: ${text.length} characters`);
          
          return new Response(JSON.stringify({
            text: text,
            messages: result.messages
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (wordError) {
          console.error('Word parsing error:', wordError);
          // Fallback: provide a helpful error message
          return new Response(JSON.stringify({
            error: 'Word document parsing failed',
            suggestion: 'Try converting to PDF for better compatibility',
            details: wordError instanceof Error ? wordError.message : 'Unknown error',
            text: 'Maaf, dokumen Word ini tidak dapat dibaca. Silakan coba konversi ke PDF terlebih dahulu.'
          }), {
            status: 422,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'create-pdf': {
        // PDF creation using pdf-lib
        try {
          const { content, title } = await req.json();
          const pdfLib = await import('https://esm.sh/pdf-lib@1.17.1');
          
          const pdfDoc = await pdfLib.PDFDocument.create();
          const page = pdfDoc.addPage([595.28, 841.89]); // A4
          const font = await pdfDoc.embedFont(pdfLib.StandardFonts.Helvetica);
          
          let yPosition = 800;
          const margin = 50;
          
          // Add title
          if (title) {
            page.drawText(title, {
              x: margin,
              y: yPosition,
              size: 18,
              font: font,
              color: pdfLib.rgb(0, 0, 0),
            });
            yPosition -= 40;
          }
          
          // Add content (simplified)
          const lines = content.split('\n');
          for (const line of lines.slice(0, 30)) { // Limit to prevent errors
            if (yPosition < 50) break;
            page.drawText(line.substring(0, 80), { // Limit line length
              x: margin,
              y: yPosition,
              size: 12,
              font: font,
              color: pdfLib.rgb(0, 0, 0),
            });
            yPosition -= 20;
          }
          
          const pdfBytes = await pdfDoc.save();
          const fileNameWithExt = fileName || `document-${Date.now()}.pdf`;
          
          // Upload to storage
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('documents')
            .upload(`generated/${fileNameWithExt}`, pdfBytes, {
              contentType: 'application/pdf',
              upsert: true
            });
          
          if (uploadError) throw uploadError;
          
          const { data: urlData } = supabase.storage
            .from('documents')
            .getPublicUrl(`generated/${fileNameWithExt}`);
          
          console.log(`✅ PDF created: ${fileNameWithExt}`);
          
          return new Response(JSON.stringify({
            url: urlData.publicUrl,
            fileName: fileNameWithExt,
            size: pdfBytes.length
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (pdfError) {
          console.error('PDF creation error:', pdfError);
          return new Response(JSON.stringify({
            error: 'PDF creation failed',
            details: pdfError instanceof Error ? pdfError.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      case 'create-excel': {
        try {
          const { data } = await req.json();
          const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
          const workbook = XLSX.utils.book_new();
          
          const worksheet = Array.isArray(data[0]) 
            ? XLSX.utils.aoa_to_sheet(data)
            : XLSX.utils.json_to_sheet(data);
          
          XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
          
          const excelBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
          const fileNameWithExt = fileName || `spreadsheet-${Date.now()}.xlsx`;
          
          const { data: uploadData, error: uploadError } = await supabase.storage
            .from('documents')
            .upload(`generated/${fileNameWithExt}`, excelBuffer, {
              contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              upsert: true
            });
          
          if (uploadError) throw uploadError;
          
          const { data: urlData } = supabase.storage
            .from('documents')
            .getPublicUrl(`generated/${fileNameWithExt}`);
          
          console.log(`✅ Excel created: ${fileNameWithExt}`);
          
          return new Response(JSON.stringify({
            url: urlData.publicUrl,
            fileName: fileNameWithExt,
            size: excelBuffer.length
          }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        } catch (excelError) {
          console.error('Excel creation error:', excelError);
          return new Response(JSON.stringify({
            error: 'Excel creation failed',
            details: excelError instanceof Error ? excelError.message : 'Unknown error'
          }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
          });
        }
      }

      default:
        return new Response(JSON.stringify({ error: 'Unknown action' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
  } catch (error) {
    console.error('❌ Document processor error:', error);
    return new Response(JSON.stringify({ 
      error: error instanceof Error ? error.message : 'Unknown error',
      details: 'Document processing failed'
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
