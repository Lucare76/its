param(
  [Parameter(Mandatory = $true)]
  [string]$PdfPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Runtime.WindowsRuntime

$code = @"
using System;
using System.Runtime.InteropServices.WindowsRuntime;
using Windows.Storage;
using Windows.Data.Pdf;
using Windows.Storage.Streams;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

public static class CodexPdfHeaderOcr {
  public static string ReadFirstPage(string path) {
    var file = StorageFile.GetFileFromPathAsync(path).AsTask().GetAwaiter().GetResult();
    var pdf = PdfDocument.LoadFromFileAsync(file).AsTask().GetAwaiter().GetResult();
    using (var page = pdf.GetPage(0)) {
      var stream = new InMemoryRandomAccessStream();
      var opts = new PdfPageRenderOptions();
      opts.DestinationWidth = 2400;
      opts.DestinationHeight = 3400;
      page.RenderToStreamAsync(stream, opts).AsTask().GetAwaiter().GetResult();
      stream.Seek(0);
      var decoder = BitmapDecoder.CreateAsync(stream).AsTask().GetAwaiter().GetResult();
      var bitmap = decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied).AsTask().GetAwaiter().GetResult();
      var engine = OcrEngine.TryCreateFromUserProfileLanguages();
      var result = engine.RecognizeAsync(bitmap).AsTask().GetAwaiter().GetResult();
      return result?.Text ?? string.Empty;
    }
  }
}
"@

Add-Type -TypeDefinition $code -Language CSharp
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[CodexPdfHeaderOcr]::ReadFirstPage($PdfPath)
