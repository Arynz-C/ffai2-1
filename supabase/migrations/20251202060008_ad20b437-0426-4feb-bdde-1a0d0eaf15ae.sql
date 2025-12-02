-- Update documents bucket to allow larger files (50MB)
UPDATE storage.buckets 
SET file_size_limit = 52428800
WHERE id = 'documents';

-- Update allowed MIME types to include Word documents
UPDATE storage.buckets 
SET allowed_mime_types = ARRAY[
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword'
]
WHERE id = 'documents';