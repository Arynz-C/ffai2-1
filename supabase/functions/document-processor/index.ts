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
    const { action, fileData, fileName, fileType, content, title, data } = await req.json();
    console.log(`📄 Document processor action: ${action}`);

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const supabase = createClient(supabaseUrl, supabaseKey);

    switch (action) {
      case 'parse-pdf': {
        // Parse PDF using pdf-parse
        const { default: pdfParse } = await import('npm:pdf-parse@1.1.1');
        const buffer = Uint8Array.from(atob(fileData), c => c.charCodeAt(0));
        const pdfData = await pdfParse(buffer);
        
        console.log(`✅ PDF parsed: ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
        
        return new Response(JSON.stringify({
          text: pdfData.text,
          pages: pdfData.numpages,
          info: pdfData.info
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'parse-excel': {
        // Parse Excel using SheetJS
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
        const buffer = Uint8Array.from(atob(fileData), c => c.charCodeAt(0));
        const workbook = XLSX.read(buffer, { type: 'array' });
        
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
      }

      case 'parse-word': {
        // Parse Word document using mammoth
        const { default: mammoth } = await import('npm:mammoth@1.6.0');
        const buffer = Uint8Array.from(atob(fileData), c => c.charCodeAt(0));
        const result = await mammoth.extractRawText({ buffer });
        
        console.log(`✅ Word parsed: ${result.value.length} characters`);
        
        return new Response(JSON.stringify({
          text: result.value,
          messages: result.messages
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'create-pdf': {
        // Create PDF using pdf-lib
        const { PDFDocument, rgb, StandardFonts } = await import('npm:pdf-lib@1.17.1');
        const pdfDoc = await PDFDocument.create();
        const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
        const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
        
        let page = pdfDoc.addPage([595.28, 841.89]); // A4 size
        let yPosition = 800;
        const margin = 50;
        const maxWidth = 495.28;
        const lineHeight = 20;
        
        // Title
        if (title) {
          page.drawText(title, {
            x: margin,
            y: yPosition,
            size: 18,
            font: boldFont,
            color: rgb(0, 0, 0),
          });
          yPosition -= 40;
        }
        
        // Content - split by lines
        const lines = content.split('\n');
        for (const line of lines) {
          if (yPosition < 50) {
            page = pdfDoc.addPage([595.28, 841.89]);
            yPosition = 800;
          }
          
          // Word wrap
          const words = line.split(' ');
          let currentLine = '';
          
          for (const word of words) {
            const testLine = currentLine + (currentLine ? ' ' : '') + word;
            const width = font.widthOfTextAtSize(testLine, 12);
            
            if (width > maxWidth) {
              page.drawText(currentLine, {
                x: margin,
                y: yPosition,
                size: 12,
                font: font,
                color: rgb(0, 0, 0),
              });
              yPosition -= lineHeight;
              currentLine = word;
              
              if (yPosition < 50) {
                page = pdfDoc.addPage([595.28, 841.89]);
                yPosition = 800;
              }
            } else {
              currentLine = testLine;
            }
          }
          
          if (currentLine) {
            page.drawText(currentLine, {
              x: margin,
              y: yPosition,
              size: 12,
              font: font,
              color: rgb(0, 0, 0),
            });
            yPosition -= lineHeight;
          }
        }
        
        const pdfBytes = await pdfDoc.save();
        const fileNameWithExt = fileName || `document-${Date.now()}.pdf`;
        
        // Upload to Supabase Storage
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
        
        console.log(`✅ PDF created and uploaded: ${fileNameWithExt}`);
        
        return new Response(JSON.stringify({
          url: urlData.publicUrl,
          fileName: fileNameWithExt,
          size: pdfBytes.length
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'create-excel': {
        // Create Excel using SheetJS
        const XLSX = await import('https://cdn.sheetjs.com/xlsx-0.20.1/package/xlsx.mjs');
        const workbook = XLSX.utils.book_new();
        
        // Assume data is array of objects or array of arrays
        const worksheet = Array.isArray(data[0]) 
          ? XLSX.utils.aoa_to_sheet(data)
          : XLSX.utils.json_to_sheet(data);
        
        XLSX.utils.book_append_sheet(workbook, worksheet, 'Sheet1');
        
        const excelBuffer = XLSX.write(workbook, { type: 'array', bookType: 'xlsx' });
        const fileNameWithExt = fileName || `spreadsheet-${Date.now()}.xlsx`;
        
        // Upload to Supabase Storage
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
        
        console.log(`✅ Excel created and uploaded: ${fileNameWithExt}`);
        
        return new Response(JSON.stringify({
          url: urlData.publicUrl,
          fileName: fileNameWithExt,
          size: excelBuffer.length
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }

      case 'create-word': {
        // Create Word document using docx
        const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import('npm:docx@8.5.0');
        
        const paragraphs = [];
        
        // Title
        if (title) {
          paragraphs.push(
            new Paragraph({
              text: title,
              heading: HeadingLevel.HEADING_1,
            })
          );
        }
        
        // Content - split by paragraphs
        const contentParagraphs = content.split('\n\n');
        for (const para of contentParagraphs) {
          paragraphs.push(
            new Paragraph({
              children: [
                new TextRun(para)
              ],
            })
          );
        }
        
        const doc = new Document({
          sections: [{
            properties: {},
            children: paragraphs,
          }],
        });
        
        const docBuffer = await Packer.toBuffer(doc);
        const fileNameWithExt = fileName || `document-${Date.now()}.docx`;
        
        // Upload to Supabase Storage
        const { data: uploadData, error: uploadError } = await supabase.storage
          .from('documents')
          .upload(`generated/${fileNameWithExt}`, docBuffer, {
            contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            upsert: true
          });
        
        if (uploadError) throw uploadError;
        
        const { data: urlData } = supabase.storage
          .from('documents')
          .getPublicUrl(`generated/${fileNameWithExt}`);
        
        console.log(`✅ Word document created and uploaded: ${fileNameWithExt}`);
        
        return new Response(JSON.stringify({
          url: urlData.publicUrl,
          fileName: fileNameWithExt,
          size: docBuffer.length
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
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
      error: error instanceof Error ? error.message : 'Unknown error' 
    }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});