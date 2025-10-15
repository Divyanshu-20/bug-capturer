/**
 * Word Document Report Generator
 * Transforms raw bug capture data into professional Microsoft Word documents
 */

class WordReportGenerator {
  constructor() {
    this.docx = null;
    this.initialized = false;
  }

  /**
   * Initialize the docx library
   */
  async initialize() {
    if (this.initialized) return;
    
    try {
      // Import docx library (assumes it's loaded via CDN or bundled)
      if (typeof docx !== 'undefined') {
        this.docx = docx;
      } else {
        throw new Error('docx library not found');
      }
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize Word generator:', error);
      throw error;
    }
  }

  /**
   * Extract structured data from raw bug capture text
   * @param {string} rawText - Raw bug capture text
   * @param {Array} screenshots - Array of screenshot objects
   * @param {Object} metadata - Additional metadata
   * @returns {Object} Structured bug report data
   */
  extractBugData(rawText, screenshots = [], metadata = {}) {
    // Limit text processing to prevent memory issues
    const maxTextLength = 100000; // 100KB limit
    if (rawText.length > maxTextLength) {
      console.warn(`Text too long (${rawText.length}), truncating to ${maxTextLength}`);
      rawText = rawText.substring(0, maxTextLength) + '\n[Content truncated due to size]';
    }
    
    const lines = rawText.split('\n');
    const data = {
      title: '',
      summary: '',
      environment: [],
      severity: 'Medium',
      stepsToReproduce: [],
      expectedResult: '[Please fill in the expected behavior here]',
      actualResult: '',
      frequency: 'Always',
      attachments: [],
      reportedBy: `Bug Context Capturer - ${new Date().toLocaleString()}`,
      url: '',
      screenshots: this.deduplicateScreenshots(screenshots || [])
    };

    let currentSection = '';
    let stepCounter = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      
      // Extract title from first meaningful line or URL
      if (!data.title && line && !line.startsWith('📊') && !line.startsWith('#')) {
        if (line.includes('http')) {
          data.title = `Issue on ${line}`;
          data.url = line;
        } else if (line.length > 5) {
          data.title = line;
        }
      }

      // Extract URL
      if (line.includes('http') && !data.url) {
        data.url = line.replace(/^URL:\s*/, '');
      }

      // Extract environment information
      if (line.includes('Browser:') || line.includes('Platform:') || 
          line.includes('Language:') || line.includes('Screen Resolution:')) {
        data.environment.push(line);
      }

      // Extract steps to reproduce
      if (line.match(/^\d+\./)) {
        const stepText = line.replace(/^\d+\.\s*/, '');
        data.stepsToReproduce.push({
          text: stepText,
          screenshots: []
        });
      }

      // Extract actual results
      if (line.includes('Steps performed:') || line.includes('actions recorded')) {
        data.actualResult += line + '\n';
      }
    }

    // Set default title if not found
    if (!data.title) {
      data.title = data.url ? `Issue on ${data.url}` : 'Bug Report';
    }

    // Map screenshots to steps
    this.mapScreenshotsToSteps(data, screenshots);

    return data;
  }

  /**
   * Map screenshots to the closest preceding step
   * @param {Object} data - Bug report data
   * @param {Array} screenshots - Array of screenshots
   */
  mapScreenshotsToSteps(data, screenshots) {
    if (!screenshots || screenshots.length === 0) return;

    // Sort screenshots by timestamp (first at top, latest at bottom)
    const sortedScreenshots = screenshots.sort((a, b) => a.timestamp - b.timestamp);

    sortedScreenshots.forEach((screenshot, index) => {
      const screenshotDesc = screenshot.description || screenshot.filename || `Screenshot ${index + 1}`;
      
      // Try to map to closest step based on description or timing
      let mapped = false;
      
      // If screenshot description mentions a step number
      const stepMatch = screenshotDesc.match(/step\s*(\d+)/i);
      if (stepMatch) {
        const stepNum = parseInt(stepMatch[1]) - 1;
        if (data.stepsToReproduce[stepNum]) {
          data.stepsToReproduce[stepNum].screenshots.push(screenshot);
          mapped = true;
        }
      }

      // If not mapped, add to attachments
      if (!mapped) {
        data.attachments.push(screenshot);
      }
    });
  }

  /**
   * Extract domain from URL
   * @param {string} url - Full URL
   * @returns {string} Domain name
   */
  extractDomainFromUrl(url) {
    try {
      const urlObj = new URL(url);
      return urlObj.hostname.replace('www.', '');
    } catch {
      return url.split('/')[2] || url;
    }
  }

  /**
   * Convert base64 image to buffer for docx with memory optimization
   * @param {string} base64Data - Base64 image data
   * @returns {Uint8Array} Image buffer
   */
  async base64ToBuffer(base64Data) {
    // Validate input
    if (!base64Data || typeof base64Data !== 'string') {
      throw new Error('Invalid base64 data provided');
    }
    
    // Check data size before processing
    if (base64Data.length > 10 * 1024 * 1024) { // 10MB limit
      console.warn('Image too large, skipping conversion');
      return null;
    }
    
    // Remove data URL prefix if present
    const base64 = base64Data.replace(/^data:image\/[a-z]+;base64,/, '');
    const binaryString = atob(base64);
    
    // Check decoded size
    if (binaryString.length > 5 * 1024 * 1024) { // 5MB decoded limit
      console.warn('Decoded image too large, skipping');
      return null;
    }
    
    const bytes = new Uint8Array(binaryString.length);
    
    // Process in chunks to avoid blocking
    const chunkSize = 1024 * 1024; // 1MB chunks
    for (let i = 0; i < binaryString.length; i += chunkSize) {
      const end = Math.min(i + chunkSize, binaryString.length);
      for (let j = i; j < end; j++) {
        bytes[j] = binaryString.charCodeAt(j);
      }
      
      // Yield control periodically for large images
      if (i > 0 && i % (chunkSize * 5) === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }
    
    return bytes;
  }

  /**
   * Generate Word document from bug data with memory optimization
   * @param {Object} bugData - Structured bug report data
   * @returns {Promise<Blob>} Word document blob
   */
  async generateWordDocument(bugData) {
    await this.initialize();

    // Check memory before starting
    if (performance.memory && performance.memory.usedJSHeapSize > 300 * 1024 * 1024) {
      console.warn('High memory usage detected, reducing document complexity');
      bugData = this.optimizeBugDataForMemory(bugData);
    }

    const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = this.docx;

    // Create document with proper styling
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: {
              font: "Calibri",
              size: 22 // 11pt = 22 half-points
            }
          }
        }
      },
      sections: []
    });

    const children = [];

    // Title (Heading 1)
    children.push(
      new Paragraph({
        text: bugData.title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 240 }
      })
    );

    // Summary
    if (bugData.summary) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Summary", bold: true, size: 24 })
          ],
          spacing: { before: 240, after: 120 }
        }),
        new Paragraph({
          text: bugData.summary,
          spacing: { after: 240 }
        })
      );
    }

    // Environment (bullet list)
    if (bugData.environment.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Environment", bold: true, size: 24 })
          ],
          spacing: { before: 240, after: 120 }
        })
      );

      bugData.environment.forEach(envItem => {
        children.push(
          new Paragraph({
            text: `• ${envItem}`,
            spacing: { after: 60 }
          })
        );
      });
    }

    // Severity/Priority
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Severity/Priority", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: bugData.severity,
        spacing: { after: 240 }
      })
    );

    // Steps to Reproduce (numbered list with embedded screenshots)
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Steps to Reproduce", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      })
    );

    for (const step of bugData.stepsToReproduce) {
      children.push(
        new Paragraph({
          text: step.text,
          spacing: { after: 120 }
        })
      );

      // Embed screenshots for this step
      for (const screenshot of step.screenshots) {
        try {
          const imageData = screenshot.data || screenshot.dataUrl;
          
          // Calculate proper dimensions maintaining aspect ratio
          const maxWidth = 600;
          const maxHeight = 450;
          let width = maxWidth;
          let height = maxHeight;
          
          // If we have viewport info, calculate aspect ratio
          if (screenshot.viewport) {
            const [viewportWidth, viewportHeight] = screenshot.viewport.split('x').map(Number);
            if (viewportWidth && viewportHeight) {
              const aspectRatio = viewportWidth / viewportHeight;
              if (aspectRatio > maxWidth / maxHeight) {
                // Wide image - constrain by width
                width = maxWidth;
                height = Math.round(maxWidth / aspectRatio);
              } else {
                // Tall image - constrain by height
                height = maxHeight;
                width = Math.round(maxHeight * aspectRatio);
              }
            }
          }
          
          children.push(
            new Paragraph({
              children: [new ImageRun({
                data: imageData,
                transformation: {
                  width: width,
                  height: height
                }
              })],
              alignment: AlignmentType.CENTER,
              spacing: { after: 120 }
            })
          );
        } catch (error) {
          console.warn('Failed to embed screenshot:', error);
          children.push(
            new Paragraph({
              text: `[Screenshot: ${screenshot.filename || 'Image'}]`,
              spacing: { after: 120 }
            })
          );
        }
      }
    }

    // Expected Result
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Expected Result", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: bugData.expectedResult,
        spacing: { after: 240 }
      })
    );

    // Actual Result
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Actual Result", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: bugData.actualResult || '[Please describe what actually happened and any error messages or unexpected behavior]',
        spacing: { after: 240 }
      })
    );

    // Frequency/Reproducibility
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Frequency/Reproducibility", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: bugData.frequency,
        spacing: { after: 240 }
      })
    );

    // Attachments (unmapped screenshots)
    if (bugData.attachments.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Attachments", bold: true, size: 24 })
          ],
          spacing: { before: 240, after: 120 }
        })
      );

      for (const attachment of bugData.attachments) {
        try {
          // Validate attachment data
          const imageData = attachment.data || attachment.dataUrl;
          if (!imageData) {
            throw new Error('No image data found in attachment');
          }
          
          // Calculate proper dimensions maintaining aspect ratio
          const maxWidth = 600;
          const maxHeight = 450;
          let width = maxWidth;
          let height = maxHeight;
          
          // If we have viewport info, calculate aspect ratio
          if (attachment.viewport) {
            const [viewportWidth, viewportHeight] = attachment.viewport.split('x').map(Number);
            if (viewportWidth && viewportHeight) {
              const aspectRatio = viewportWidth / viewportHeight;
              if (aspectRatio > maxWidth / maxHeight) {
                // Wide image - constrain by width
                width = maxWidth;
                height = Math.round(maxWidth / aspectRatio);
              } else {
                // Tall image - constrain by height
                height = maxHeight;
                width = Math.round(maxHeight * aspectRatio);
              }
            }
          }
          
          children.push(
            new Paragraph({
              children: [new ImageRun({
                data: imageData,
                transformation: {
                  width: width,
                  height: height
                }
              })],
              alignment: AlignmentType.CENTER,
              spacing: { after: 120 }
            })
          );
        } catch (error) {
          console.warn('Failed to embed attachment:', error);
          children.push(
            new Paragraph({
              text: `[Attachment: ${attachment.filename || 'Image'}]`,
              spacing: { after: 120 }
            })
          );
        }
      }
    }

    // Reported by
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Reported by", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: bugData.reportedBy,
        spacing: { after: 240 }
      })
    );

    // Add children to document sections
    doc.addSection({
      properties: {},
      children: children
    });

    // Generate blob (browser-compatible)
    return await this.docx.Packer.toBlob(doc);
  }

  /**
   * Save Word document to file
   * @param {Blob} docBlob - Word document blob
   * @param {string} filename - Filename for the document
   */
  saveDocument(docBlob, filename = 'bug-report.docx') {
    if (typeof saveAs !== 'undefined') {
      saveAs(docBlob, filename);
    } else {
      // Fallback download method
      const url = URL.createObjectURL(docBlob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  }

  /**
   * Deduplicate screenshots based on dataURL or timestamp with memory limits
   * @param {Array} screenshots - Array of screenshot objects
   * @returns {Array} Deduplicated screenshots
   */
  deduplicateScreenshots(screenshots) {
    if (!screenshots || screenshots.length === 0) return [];
    
    // Limit total screenshots to prevent memory issues
    const maxScreenshots = 20;
    let limitedScreenshots = screenshots;
    
    if (screenshots.length > maxScreenshots) {
      console.warn(`Too many screenshots (${screenshots.length}), keeping only ${maxScreenshots}`);
      // Keep first few and last few screenshots
      const keepFirst = Math.floor(maxScreenshots * 0.6);
      const keepLast = maxScreenshots - keepFirst;
      limitedScreenshots = [
        ...screenshots.slice(0, keepFirst),
        ...screenshots.slice(-keepLast)
      ];
    }
    
    const seen = new Set();
    const uniqueScreenshots = [];
    
    limitedScreenshots.forEach(screenshot => {
      // Skip if image is too large
      const dataURL = screenshot.dataURL || screenshot.dataUrl || '';
      if (dataURL.length > 5 * 1024 * 1024) {
        console.warn('Screenshot too large, skipping');
        return;
      }
      
      // Use dataURL as primary identifier, fallback to timestamp + description
      const identifier = dataURL || 
                        `${screenshot.timestamp}_${screenshot.description || screenshot.filename || ''}`;
      
      if (!seen.has(identifier)) {
        seen.add(identifier);
        uniqueScreenshots.push(screenshot);
      }
    });
    
    console.log(`Deduplicated screenshots: ${screenshots.length} -> ${uniqueScreenshots.length}`);
    return uniqueScreenshots;
  }

  /**
   * Main method to generate and save bug report
   * @param {string} rawBugText - Raw bug capture text
   * @param {Array} screenshots - Array of screenshot objects
   * @param {Object} metadata - Additional metadata
   * @param {string} filename - Output filename
   */
  async generateBugReport(rawBugText, screenshots = [], metadata = {}, filename = 'bug-report.docx') {
    try {
      // Deduplicate screenshots before processing
      const uniqueScreenshots = this.deduplicateScreenshots(screenshots);
      
      // Extract structured data
      const bugData = this.extractBugData(rawBugText, uniqueScreenshots, metadata);
      
      // Generate Word document
      const docBlob = await this.generateWordDocument(bugData);
      
      // Save document
      this.saveDocument(docBlob, filename);
      
      return { success: true, message: 'Bug report generated successfully' };
    } catch (error) {
      console.error('Failed to generate bug report:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Generate TVD report with all screenshots from session
   * @param {string} rawBugText - Raw bug capture text
   * @param {Array} screenshots - Array of all screenshot objects from session
   * @param {Object} metadata - Additional metadata
   * @param {string} filename - Output filename
   */
  async generateTVDReport(rawBugText, screenshots = [], metadata = {}, filename = 'tvd-report.docx') {
    try {
      // Deduplicate screenshots before processing
      const uniqueScreenshots = this.deduplicateScreenshots(screenshots);
      
      // Extract structured data
      const bugData = this.extractTVDData(rawBugText, uniqueScreenshots, metadata);
      
      // Generate Word document with all screenshots
      const docBlob = await this.generateTVDWordDocument(bugData);
      
      // Save document
      this.saveDocument(docBlob, filename);
      
      return { success: true, message: `TVD report generated successfully with ${uniqueScreenshots.length} screenshots` };
    } catch (error) {
      console.error('Failed to generate TVD report:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Extract structured data specifically for TVD report (screenshots only)
   * @param {string} rawText - Raw bug capture text
   * @param {Array} screenshots - Array of all screenshot objects
   * @param {Object} metadata - Additional metadata
   * @returns {Object} Structured TVD report data
   */
  extractTVDData(rawText, screenshots = [], metadata = {}) {
    const data = {
      title: `TVD Report - ${metadata.url ? this.extractDomainFromUrl(metadata.url) : 'Bug Session'}`,
      summary: `Screenshots documentation with ${screenshots.length} captured images`,
      environment: [],
      severity: 'Documentation',
      stepsToReproduce: [],
      expectedResult: 'Complete visual documentation for testing and development purposes',
      actualResult: `Session captured ${screenshots.length} screenshots for visual documentation`,
      frequency: 'Session-based',
      attachments: [],
      reportedBy: `TVD Report - ${new Date().toLocaleString()}`,
      url: metadata.url || '',
      screenshots: screenshots || [],
      sessionInfo: {
        totalScreenshots: screenshots.length,
        totalSteps: metadata.totalSteps || 0,
        sessionDuration: this.calculateSessionDuration(screenshots),
        screenshotTypes: this.categorizeScreenshots(screenshots)
      }
    };

    // Add minimal environment info for TVD
    data.environment.push(`Total Screenshots: ${screenshots.length}`);
    data.environment.push(`Session Duration: ${data.sessionInfo.sessionDuration}`);
    if (metadata.browser) {
      data.environment.push(`Browser: ${metadata.browser}`);
    }
    if (metadata.platform) {
      data.environment.push(`Platform: ${metadata.platform}`);
    }

    return data;
  }

  /**
   * Optimize bug data for memory constraints
   * @param {Object} bugData - Original bug data
   * @returns {Object} Optimized bug data
   */
  optimizeBugDataForMemory(bugData) {
    const optimized = { ...bugData };
    
    // Limit screenshots more aggressively
    if (optimized.screenshots && optimized.screenshots.length > 10) {
      console.warn('Reducing screenshots for memory optimization');
      optimized.screenshots = optimized.screenshots.slice(0, 10);
    }
    
    // Truncate long text fields
    if (optimized.summary && optimized.summary.length > 5000) {
      optimized.summary = optimized.summary.substring(0, 5000) + '... [truncated]';
    }
    
    if (optimized.actualResult && optimized.actualResult.length > 10000) {
      optimized.actualResult = optimized.actualResult.substring(0, 10000) + '... [truncated]';
    }
    
    // Limit steps to reproduce
    if (optimized.stepsToReproduce && optimized.stepsToReproduce.length > 20) {
      optimized.stepsToReproduce = optimized.stepsToReproduce.slice(0, 20);
    }
    
    return optimized;
  }

  /**
   * Calculate session duration from screenshots
   * @param {Array} screenshots - Array of screenshots
   * @returns {string} Formatted duration
   */
  calculateSessionDuration(screenshots) {
    if (!screenshots || screenshots.length < 2) return 'Unknown';
    
    const timestamps = screenshots
      .map(s => s.timestamp)
      .filter(t => t && !isNaN(t))
      .sort((a, b) => a - b);
    
    if (timestamps.length < 2) return 'Unknown';
    
    const durationMs = timestamps[timestamps.length - 1] - timestamps[0];
    const minutes = Math.floor(durationMs / 60000);
    const seconds = Math.floor((durationMs % 60000) / 1000);
    
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    } else {
      return `${seconds}s`;
    }
  }

  /**
   * Categorize screenshots by type
   * @param {Array} screenshots - Array of screenshots
   * @returns {Object} Categorized screenshot counts
   */
  categorizeScreenshots(screenshots) {
    const types = {};
    screenshots.forEach(screenshot => {
      const type = screenshot.type || 'unknown';
      types[type] = (types[type] || 0) + 1;
    });
    return types;
  }

  /**
   * Generate TVD-specific Word document (screenshots only)
   * @param {Object} tvdData - Structured TVD report data
   * @returns {Promise<Blob>} Word document blob
   */
  async generateTVDWordDocument(tvdData) {
    await this.initialize();

    const { Document, Paragraph, TextRun, HeadingLevel, AlignmentType, ImageRun } = this.docx;

    // Create document with proper styling
    const doc = new Document({
      styles: {
        default: {
          document: {
            run: {
              font: "Calibri",
              size: 22 // 11pt = 22 half-points
            }
          }
        }
      },
      sections: []
    });

    const children = [];

    // Title (Heading 1)
    children.push(
      new Paragraph({
        text: tvdData.title,
        heading: HeadingLevel.HEADING_1,
        spacing: { after: 240 }
      })
    );

    // Session Summary (minimal)
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Summary", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      }),
      new Paragraph({
        text: tvdData.summary,
        spacing: { after: 240 }
      })
    );

    // Environment (minimal info only)
    if (tvdData.environment.length > 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: "Environment", bold: true, size: 24 })
          ],
          spacing: { before: 240, after: 120 }
        })
      );

      tvdData.environment.forEach(envItem => {
        children.push(
          new Paragraph({
            text: `• ${envItem}`,
            spacing: { after: 60 }
          })
        );
      });
    }

    // Screenshots Section (main content)
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: "Screenshots", bold: true, size: 24 })
        ],
        spacing: { before: 240, after: 120 }
      })
    );

    // Add all screenshots in chronological order (first at top, latest at bottom)
    const sortedScreenshots = tvdData.screenshots.sort((a, b) => a.timestamp - b.timestamp);
    sortedScreenshots.forEach((screenshot, index) => {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: `Screenshot ${index + 1}: ${screenshot.description || 'Screenshot'}`, bold: true, size: 20 })
          ],
          spacing: { before: 180, after: 60 }
        })
      );

      try {
        const imageData = screenshot.data || screenshot.dataUrl;
        
        // Calculate proper dimensions maintaining aspect ratio
        const maxWidth = 600;
        const maxHeight = 450;
        let width = maxWidth;
        let height = maxHeight;
        
        // If we have viewport info, calculate aspect ratio
        if (screenshot.viewport) {
          const [viewportWidth, viewportHeight] = screenshot.viewport.split('x').map(Number);
          if (viewportWidth && viewportHeight) {
            const aspectRatio = viewportWidth / viewportHeight;
            if (aspectRatio > maxWidth / maxHeight) {
              // Wide image - constrain by width
              width = maxWidth;
              height = Math.round(maxWidth / aspectRatio);
            } else {
              // Tall image - constrain by height
              height = maxHeight;
              width = Math.round(maxHeight * aspectRatio);
            }
          }
        }
        
        children.push(
          new Paragraph({
            children: [new ImageRun({
              data: imageData,
              transformation: {
                width: width,
                height: height
              }
            })],
            alignment: AlignmentType.CENTER,
            spacing: { after: 120 }
          })
        );
      } catch (error) {
        console.warn('Failed to embed screenshot:', error);
        children.push(
          new Paragraph({
            text: `[Screenshot: ${screenshot.filename || 'Image'}]`,
            spacing: { after: 120 }
          })
        );
      }
    });

    // Add children to document sections
    doc.addSection({
      properties: {},
      children: children
    });

    // Generate blob (browser-compatible)
    return await this.docx.Packer.toBlob(doc);
  }
}

// Export for use in other modules
if (typeof module !== 'undefined' && module.exports) {
  module.exports = WordReportGenerator;
} else {
  window.WordReportGenerator = WordReportGenerator;
}