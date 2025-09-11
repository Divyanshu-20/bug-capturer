/**
 * Bug Capturer Content Script - Local-only capture with redaction
 * SECURITY: No external network calls, conservative redaction rules
 */

(function() {
  'use strict';
  
  // Prevent double injection
  if (window.__bugCapturerExtInjected) return;
  window.__bugCapturerExtInjected = true;
  
  // Initialize state
  window.bcState = window.bcState || {
    steps: [],
    startTime: Date.now(),
    recording: false,
    selectorMode: false,
    indicator: null,
    actualUrl: null // Store the actual tab URL
  };
  
  // REDACTION RULES: More specific patterns to avoid over-redaction
  const SENSITIVE_PATTERNS = /password|pwd|secret|token|key|ssn|creditcard|credit-card|cardnumber|card-number/i;
  const MAX_INPUT_LENGTH = 100; // Increased from 80
  
  /**
   * Get safe text from element with redaction
   */
  function getSafeText(element, value = null) {
    if (!element) return '';
    
    const text = value || element.value || element.innerText || element.textContent || element.alt || element.title || '';
    const name = element.name || element.id || element.placeholder || element.type || '';
    
    // Apply redaction rules - only for truly sensitive fields
    if (SENSITIVE_PATTERNS.test(name)) {
      return '[REDACTED]'; // More descriptive than ***
    }
    
    // For form elements, try to get a meaningful identifier
    if (element.tagName && ['INPUT', 'SELECT', 'TEXTAREA'].includes(element.tagName)) {
      const identifier = element.placeholder || element.name || element.id || element.type || 'field';
      if (value && value.trim()) {
        return `${identifier}: ${value.length > MAX_INPUT_LENGTH ? value.slice(0, 77) + '...' : value}`;
      }
      return identifier;
    }
    
    // Mask long inputs
    if (text.length > MAX_INPUT_LENGTH) {
      return text.slice(0, 97) + '...';
    }
    
    return text.toString().trim().slice(0, 200);
  }
  
  /**
   * Generate CSS selector for element
   */
  function getCssSelector(element) {
    if (!element) return '';
    if (element.id) return '#' + element.id;
    
    const path = [];
    while (element && element.nodeType === 1) {
      let selector = element.tagName.toLowerCase();
      if (element.className) {
        const classes = element.className.split(' ').filter(c => c && !c.startsWith('bc-'));
        if (classes.length) selector += '.' + classes[0];
      }
      path.unshift(selector);
      element = element.parentElement;
    }
    return path.join(' > ');
  }

  /**
   * Get the actual tab URL from background script
   */
  async function getActualTabUrl() {
    try {
      // If we already have the URL cached, use it
      if (window.bcState.actualUrl) {
        return window.bcState.actualUrl;
      }

      // Get the current tab URL from background script
      const response = await chrome.runtime.sendMessage({ cmd: 'get-current-tab-url' });
      if (response && response.url) {
        window.bcState.actualUrl = response.url;
        return response.url;
      }
    } catch (error) {
      console.warn('Failed to get actual tab URL:', error);
    }
    
    // Fallback to current location if we can't get the tab URL
    return location.href;
  }
  
  /**
   * Record a step and send to background
   */
  async function recordStep(typeOrStep, element, details = '') {
    if (!window.bcState.recording) return;
    
    // Get the actual tab URL
    const actualUrl = await getActualTabUrl();
    
    let step;
    
    // Handle both patterns: recordStep(type, element, details) and recordStep(stepObject)
    if (typeof typeOrStep === 'object') {
      // If first parameter is an object, use it as the step and update URL
      step = {
        ...typeOrStep,
        url: actualUrl,
        sessionId: window.bcState.sessionId
      };
    } else {
      // If first parameter is a string (type), create step object
      step = {
        type: 'step',
        time: Date.now(),
        url: actualUrl,
        text: getSafeText(element, details),
        selector: getCssSelector(element),
        sessionId: window.bcState.sessionId, // Add session ID for continuity
        meta: {
          action: typeOrStep,
          tagName: element?.tagName || '',
          timestamp: Date.now() - window.bcState.startTime
        }
      };
    }
    
    // Store locally
    window.bcState.steps.push(step);
    
    // Send to background script
    try {
      chrome.runtime.sendMessage({
        cmd: 'store-step',
        step: step
      }).catch(err => {
        if (err.message && err.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated, stopping recording');
          window.bcState.recording = false;
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'none';
          }
        } else {
          console.warn('Failed to send step to background:', err);
        }
      });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('Bug Capturer: Extension context invalidated, stopping recording');
        window.bcState.recording = false;
        if (window.bcState.indicator) {
          window.bcState.indicator.style.display = 'none';
        }
      } else {
        console.error('Bug Capturer: Error recording step:', error);
      }
    }
    
    // Post message for optional UI forwarding
    window.postMessage({
      __bugCapturer: true,
      payload: step
    }, '*');
  }
  
  /**
   * Event handlers for user interactions
   */
  
  // Track input timers for debouncing
  const inputTimers = new WeakMap();
  
  // Click handler
  document.addEventListener('click', function(e) {
    if (e.target.closest('[data-bc-ignore]')) return;
    recordStep('click', e.target).catch(console.error);
  }, true);
  
  
  // Input event with debouncing - capture after user stops typing (like universal-bookmarklet)
  document.addEventListener('input', function(e) {
    if (e.target.closest('[data-bc-ignore]')) return;
    
    const element = e.target;
    const tagName = element.tagName.toLowerCase();
    
    if (!['input', 'textarea'].includes(tagName)) return;
    
    // Clear existing timer for this element
    if (inputTimers.has(element)) {
      clearTimeout(inputTimers.get(element));
    }
    
    // Set new timer to capture after user stops typing
    inputTimers.set(element, setTimeout(async () => {
      if (element.value && element.value.trim() !== '') {
        const name = element.placeholder || element.name || element.id || element.type || element.tagName;
        const fieldName = name || 'field';
        const inputValue = element.value.trim();
        
        console.log('Bug Capturer: Captured input value:', inputValue);
        
        // Check if this is a sensitive field (only redact truly sensitive fields)
        const isSensitive = SENSITIVE_PATTERNS.test(fieldName.toLowerCase());
        const displayValue = isSensitive ? '[REDACTED]' : inputValue;
        
        // Create step with proper value handling
        const step = {
          type: 'step',
          time: Date.now(),
          url: await getActualTabUrl(),
          text: fieldName,
          selector: getCssSelector(element),
          sessionId: window.bcState.sessionId,
          meta: {
            action: 'input',
            tagName: element.tagName || '',
            timestamp: Date.now() - window.bcState.startTime,
            value: displayValue, // Store display value (redacted if sensitive)
            details: `Entered "${displayValue}" in ${fieldName}` // Store formatted description
          }
        };
        
        recordStep(step).catch(console.error);
      }
      inputTimers.delete(element);
    }, 800)); // 800ms delay like universal-bookmarklet
  }, true);
  
  // Change handler for select dropdowns and other form elements
  document.addEventListener('change', function(e) {
    if (e.target.closest('[data-bc-ignore]')) return;
    
    const element = e.target;
    const tagName = element.tagName.toLowerCase();
    
    if (tagName === 'select') {
      const selectedOption = element.options[element.selectedIndex];
      const value = selectedOption ? selectedOption.text : element.value;
      recordStep('select', element, `Selected: ${value}`).catch(console.error);
    } else if (tagName === 'input' && (element.type === 'checkbox' || element.type === 'radio')) {
      recordStep('toggle', element, `${element.type} ${element.checked ? 'checked' : 'unchecked'}`).catch(console.error);
    }
  }, true);
  
  // Focus handler for form elements - DISABLED to reduce verbosity
  // document.addEventListener('focus', function(e) {
  //   if (e.target.closest('[data-bc-ignore]')) return;
  //   
  //   const element = e.target;
  //   const tagName = element.tagName.toLowerCase();
  //   
  //   if (['input', 'textarea', 'select'].includes(tagName)) {
  //     recordStep('focus', element, `Focused on ${element.placeholder || element.name || tagName}`).catch(console.error);
  //   }
  // }, true);
  
  // Blur handler for form elements - DISABLED to reduce verbosity
  // document.addEventListener('blur', function(e) {
  //   if (e.target.closest('[data-bc-ignore]')) return;
  //   
  //   const element = e.target;
  //   const tagName = element.tagName.toLowerCase();
  //   
  //   if (['input', 'textarea', 'select'].includes(tagName) && element.value) {
  //     recordStep('blur', element, `Left field with value: ${getSafeText(element, element.value)}`).catch(console.error);
  //   }
  // }, true);
  
  // Submit handler with form data capture - improved accuracy
  document.addEventListener('submit', function(e) {
    if (e.target.closest('[data-bc-ignore]')) return;
    
    const form = e.target;
    
    // Only record if form has meaningful content
    const formData = new FormData(form);
    const hasContent = Array.from(formData.entries()).some(([name, value]) => 
      value && value.toString().trim() !== '' && !SENSITIVE_PATTERNS.test(name)
    );
    
    if (hasContent) {
      // Get form identifier for better tracking
      const formId = form.id || form.name || form.className || 'form';
      const formInfo = `Submitted the form`;
      recordStep('submit', form, formInfo).catch(console.error);
    }
  }, true);
  
  // Keydown handler for special keys
  document.addEventListener('keydown', function(e) {
    if (e.target.closest('[data-bc-ignore]')) return;
    
    // Record Enter key presses in form elements
    if (e.key === 'Enter' && ['input', 'textarea'].includes(e.target.tagName.toLowerCase())) {
      recordStep('keypress', e.target, 'Pressed Enter').catch(console.error);
    }
    // Handle Alt+Ctrl+P key combination for screenshots
    else if (e.altKey && e.ctrlKey && e.code === 'KeyP' && window.bcState.recording) {
      e.preventDefault();
      
      // Show toast notification
      showToast('📸 Capturing screenshot...');
        
        // Trigger screenshot capture via background script
        chrome.runtime.sendMessage({
          cmd: 'capture-screenshot-pause',
          timestamp: Date.now()
        }).then(response => {
          if (response && response.success) {
            // Also add to popup's screenshots array for gallery display
            const screenshotData = response.screenshot || response;
            const dataURL = screenshotData.dataURL || screenshotData.screenshot;
            
            if (dataURL) {
              const screenshot = {
                id: Date.now(),
                dataURL: dataURL,
                type: 'fullpage',
                timestamp: screenshotData.timestamp || Date.now(),
                url: screenshotData.url || window.location.href,
                viewport: screenshotData.viewport || `${window.innerWidth}x${window.innerHeight}`
              };
              
              // Add to popup's screenshots array
              chrome.runtime.sendMessage({
                cmd: 'add-screenshot-to-gallery',
                screenshot: screenshot
              }).catch(err => console.warn('Failed to add screenshot to gallery:', err));
            }
            
            showToast('📸 Screenshot captured successfully!');
          } else {
            showToast('❌ Screenshot capture failed');
          }
        }).catch(error => {
          console.error('Screenshot capture failed:', error);
          showToast('❌ Screenshot capture failed');
        });
    }
    // Record Escape key presses
    else if (e.key === 'Escape') {
      recordStep('keypress', e.target, 'Pressed Escape').catch(console.error);
    }
    // Record Tab navigation
    else if (e.key === 'Tab') {
      recordStep('navigation', e.target, `Tab ${e.shiftKey ? 'backward' : 'forward'}`).catch(console.error);
    }
  }, true);
  
  /**
   * Create interactive indicator element with toggle functionality
   */
  function createIndicator() {
    if (window.bcState.indicator) {
      window.bcState.indicator.remove();
    }
    
    const indicator = document.createElement('div');
    indicator.setAttribute('data-bc-ignore', 'true');
    indicator.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      background: ${window.bcState.recording ? 'linear-gradient(135deg, #10b981, #059669)' : 'linear-gradient(135deg, #ef4444, #dc2626)'};
      color: white;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 2147483647;
      box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      cursor: pointer;
      user-select: none;
      transition: all 0.3s ease;
      display: none;
      align-items: center;
      gap: 6px;
    `;
    
    updateIndicatorContent(indicator);
    
    // Toggle functionality
    indicator.addEventListener('click', function(e) {
      e.stopPropagation();
      toggleRecording();
    });
    
    // Hover effects
    indicator.addEventListener('mouseenter', function() {
      this.style.transform = 'scale(1.05)';
    });
    
    indicator.addEventListener('mouseleave', function() {
      this.style.transform = 'scale(1)';
    });
    
    // Safely append to document
    if (document.documentElement) {
      document.documentElement.appendChild(indicator);
    }
    
    window.bcState.indicator = indicator;
    return indicator;
  }
  
  /**
   * Update indicator content based on current state
   */
  function updateIndicatorContent(indicator) {
    if (!indicator) return;
    
    if (window.bcState.selectorMode) {
      indicator.innerHTML = '🎯 <span>Selector Mode</span>';
      indicator.style.background = 'linear-gradient(135deg, #f59e0b, #d97706)';
    } else if (window.bcState.recording) {
      indicator.innerHTML = `
        🔴 <span>Recording</span>
        <div style="font-size: 9px; margin-top: 2px; opacity: 0.8;">Press Alt+Ctrl+P for screenshot</div>
        <button id="pause-recording" style="
          margin-left: 8px;
          background: #dc3545;
          color: white;
          border: none;
          padding: 2px 6px;
          border-radius: 2px;
          font-size: 10px;
          cursor: pointer;
        ">⏸️</button>
      `;
      indicator.style.background = 'linear-gradient(135deg, #10b981, #059669)';
      
      // Attach pause button event listener
      const pauseBtn = indicator.querySelector('#pause-recording');
      if (pauseBtn) {
        pauseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.bcState.recording = false;
          // Persist paused state so background does not try to auto-restore
          try {
            chrome.runtime.sendMessage({
              cmd: 'update-recording-state',
              isRecording: false,
              sessionId: window.bcState.sessionId,
              startTime: window.bcState.startTime
            }).catch(err => console.warn('Failed to persist paused state:', err));
          } catch (err) {
            console.warn('Error persisting paused state:', err);
          }
          updateIndicatorContent(indicator);
        });
      }
    } else {
      indicator.innerHTML = `
        ⏸️ <span>Paused</span>
        <button id="start-recording" style="
          margin-left: 8px;
          background: #28a745;
          color: white;
          border: none;
          padding: 2px 6px;
          border-radius: 2px;
          font-size: 10px;
          cursor: pointer;
        ">▶️</button>
      `;
      indicator.style.background = 'linear-gradient(135deg, #ef4444, #dc2626)';
      
      // Attach start button event listener
      const startBtn = indicator.querySelector('#start-recording');
      if (startBtn) {
        startBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          window.bcState.recording = true;
          // Persist resumed state
          try {
            chrome.runtime.sendMessage({
              cmd: 'update-recording-state',
              isRecording: true,
              sessionId: window.bcState.sessionId,
              startTime: window.bcState.startTime || Date.now()
            }).catch(err => console.warn('Failed to persist resumed state:', err));
          } catch (err) {
            console.warn('Error persisting resumed state:', err);
          }
          updateIndicatorContent(indicator);
        });
      }
    }
  }
  
  /**
   * Toggle recording state
   */
  function toggleRecording() {
    window.bcState.recording = !window.bcState.recording;
    // Persist toggled state so background reflects reality
    try {
      chrome.runtime.sendMessage({
        cmd: 'update-recording-state',
        isRecording: window.bcState.recording,
        sessionId: window.bcState.sessionId,
        startTime: window.bcState.startTime
      }).catch(err => console.warn('Failed to persist toggled state:', err));
    } catch (err) {
      console.warn('Error persisting toggled state:', err);
    }
    updateIndicatorContent(window.bcState.indicator);
    
    if (window.bcState.recording) {
      // Resume recording - restore session if needed
      if (!window.bcState.sessionId) {
        window.bcState.sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
      }
      if (!window.bcState.startTime) {
        window.bcState.startTime = Date.now();
      }
      
      // Update persistent state to recording
      try {
        chrome.runtime.sendMessage({
          cmd: 'update-recording-state',
          isRecording: true,
          sessionId: window.bcState.sessionId,
          startTime: window.bcState.startTime
        }).catch(err => console.warn('Failed to update recording state:', err));
      } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated, stopping recording');
          window.bcState.recording = false;
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'none';
          }
        } else {
          console.error('Bug Capturer: Error updating recording state:', error);
        }
      }
      
      showToast('Recording resumed');
    } else {
      // Pause recording - generate intermediate report
      generateReport().then(report => {
        try {
          chrome.runtime.sendMessage({
            cmd: 'save-report',
            report: report,
            isPause: true
          }).catch(err => console.warn('Failed to save pause report:', err));
        } catch (error) {
          if (error.message && error.message.includes('Extension context invalidated')) {
            console.warn('Bug Capturer: Extension context invalidated during report save');
          } else {
            console.error('Bug Capturer: Error saving pause report:', error);
          }
        }
      });
      
      // Update persistent state to paused (but keep session data)
      try {
        chrome.runtime.sendMessage({
          cmd: 'update-recording-state',
          isRecording: false,
          sessionId: window.bcState.sessionId, // Keep session ID
          startTime: window.bcState.startTime  // Keep start time
        }).catch(err => console.warn('Failed to update recording state:', err));
      } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated during state update');
        } else {
          console.error('Bug Capturer: Error updating recording state:', error);
        }
      }
      
      showToast('Recording paused');
    }
  }
  
  /**
   * Update indicator status with step count and controls
   */
  function updateIndicatorStatus() {
    if (window.bcState.indicator) {
      updateIndicatorContent(window.bcState.indicator);
    }
  }
  
  /**
   * Show temporary toast notification
   */
  function showToast(message) {
    const toast = document.createElement('div');
    toast.setAttribute('data-bc-ignore', 'true');
    toast.style.cssText = `
      position: fixed;
      top: 60px;
      right: 10px;
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 8px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 2147483646;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;
    toast.textContent = message;
    
    if (document.documentElement) {
      document.documentElement.appendChild(toast);
      
      // Animate in
      setTimeout(() => toast.style.opacity = '1', 10);
      
      // Remove after delay
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 2000);
    }
  }
  
  /**
   * Remove indicator and stop recording
   */
  function stopRecording() {
    window.bcState.recording = false;
    if (window.bcState.indicator) {
      window.bcState.indicator.remove();
      window.bcState.indicator = null;
    }
  }
  
  // Listen for messages from extension popup and other sources
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.__bugCapturerStop) {
      stopRecording();
      sendResponse({ok: true});
    } else if (message.__bugCapturerToggle) {
      toggleRecording();
      sendResponse({ok: true, recording: window.bcState.recording});
    } else if (message.__bugCapturerGetState) {
      sendResponse({ok: true, recording: window.bcState.recording, selectorMode: window.bcState.selectorMode});
    } else if (message.cmd === 'capture-screenshot-pause') {
      // Handle screenshot capture during pause
      captureScreenshotPause().then(screenshot => {
        sendResponse({ success: true, dataURL: screenshot, timestamp: Date.now(), url: window.location.href, viewport: `${window.innerWidth}x${window.innerHeight}` });
      }).catch(error => {
        console.error('Screenshot capture error:', error);
        sendResponse({ success: false, error: error.message });
      });
      return true; // Keep message channel open for async response
    } else if (message.type === 'capture-test-scenario') {
      recordTestScenario(message.scenario);
      sendResponse({ success: true });
    } else if (message.type === 'activate-extension') {
      // Initialize extension components when activated
      // Ensure recording state is active and persisted
      try {
        window.bcState.recording = true;
        if (!window.bcState.sessionId) {
          window.bcState.sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
        }
        if (!window.bcState.startTime) {
          window.bcState.startTime = Date.now();
        }
        // Persist state so popup recognizes activation even after it closes
        chrome.runtime.sendMessage({
          cmd: 'update-recording-state',
          isRecording: true,
          sessionId: window.bcState.sessionId,
          startTime: window.bcState.startTime
        }).catch(err => console.warn('Failed to persist activation state:', err));
      } catch (e) {
        console.warn('Failed to set activation state:', e);
      }

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          createIndicator();
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'flex';
          }
          setupErrorDetection();
          // Update indicator to reflect recording=true
          if (window.bcState.indicator) {
            updateIndicatorContent(window.bcState.indicator);
          }
        });
      } else {
        createIndicator();
        if (window.bcState.indicator) {
          window.bcState.indicator.style.display = 'flex';
        }
        setupErrorDetection();
        // Update indicator to reflect recording=true
        if (window.bcState.indicator) {
          updateIndicatorContent(window.bcState.indicator);
        }
      }
      sendResponse({ ok: true, message: 'Extension activated' });
    } else if (message.type === 'deactivate-extension') {
       // Generate report before deactivation
       generateReport().then(report => {
         try {
           chrome.runtime.sendMessage({
             cmd: 'save-report',
             report: report
           }).catch(err => console.warn('Failed to save report:', err));
         } catch (error) {
           if (error.message && error.message.includes('Extension context invalidated')) {
             console.warn('Bug Capturer: Extension context invalidated during final report save');
           } else {
             console.error('Bug Capturer: Error saving final report:', error);
           }
         }
       });
       
       // Update persistent state
       try {
         chrome.runtime.sendMessage({
           cmd: 'update-recording-state',
           isRecording: false,
           sessionId: null,
           startTime: null
         });
       } catch (error) {
         if (error.message && error.message.includes('Extension context invalidated')) {
           console.warn('Bug Capturer: Extension context invalidated during deactivation state update');
         } else {
           console.error('Bug Capturer: Error updating deactivation state:', error);
         }
       }
       
       // Clean up extension components when deactivated
       window.bcState.recording = false;
       if (window.bcState.indicator) {
         window.bcState.indicator.style.display = 'none';
       }
       if (window.bcState.errorObserver) {
         window.bcState.errorObserver.disconnect();
         window.bcState.errorObserver = null;
       }
       sendResponse({ ok: true, message: 'Extension deactivated' });
    } else if (message.type === 'restore-recording-state') {
      // Restore recording state after navigation
      if (message.isRecording) {
        window.bcState.recording = true;
        window.bcState.sessionId = message.sessionId;
        window.bcState.startTime = message.startTime;
        
        // Recreate indicator if it doesn't exist or show existing one
        if (!window.bcState.indicator) {
          createIndicator();
          setupErrorDetection();
        }
        
        if (window.bcState.indicator) {
          window.bcState.indicator.style.display = 'flex';
          updateIndicatorStatus();
        }
      }
      sendResponse({ ok: true, message: 'State restored' });
    } else if (message.type === 'start-custom-area-selection') {
      // Start custom area selection from popup
      startCustomAreaSelection();
      sendResponse({ ok: true, message: 'Custom area selection started' });
    }
  });
  
  // Listen for stop recording messages from window
  window.addEventListener('message', function(e) {
    if (e.data && e.data.__bugCapturerStop) {
      stopRecording();
    } else if (e.data && e.data.__bugCapturerToggle) {
      toggleRecording();
    }
  });

  // Navigation tracking without automatic screenshots
  let navigationStartTime = null;
  let lastNavigationUrl = window.location.href;

  // Track URL changes for updating stored URL references
  function updateCurrentUrl() {
    const newUrl = window.location.href;
    if (newUrl !== lastNavigationUrl) {
      console.log('URL changed from', lastNavigationUrl, 'to', newUrl);
      
      // Update the cached URL in state
      window.bcState.actualUrl = newUrl;
      lastNavigationUrl = newUrl;
      
      // Notify background script of URL change
      try {
        chrome.runtime.sendMessage({
          cmd: 'update-current-url',
          url: newUrl
        }).catch(err => console.warn('Failed to update current URL in background:', err));
      } catch (error) {
        console.warn('Error updating current URL:', error);
      }
      
      // Record navigation step if recording
      if (window.bcState.recording) {
        recordStep('navigation', null, `Navigated to ${newUrl}`).catch(console.error);
      }
    }
  }

  // Track navigation events without capturing screenshots automatically
  window.addEventListener('beforeunload', function(e) {
    if (window.bcState.recording) {
      console.log('Navigation detected, recording navigation step...');
      // Only record navigation step, no automatic screenshot
      const currentUrl = window.location.href;
      recordStep('navigation', null, `Navigating away from ${currentUrl}`).catch(console.error);
    }
  });

  // Handle navigation completion
  window.addEventListener('load', function() {
    // Always update URL on load, regardless of recording state
    updateCurrentUrl();
  });
  
  // Listen for popstate events (back/forward navigation)
  window.addEventListener('popstate', function() {
    // Update URL on popstate events
    setTimeout(updateCurrentUrl, 100); // Small delay to ensure URL is updated
  });
  
  // Monitor for URL changes in SPAs using MutationObserver
  const urlObserver = new MutationObserver(() => {
    updateCurrentUrl();
  });
  
  // Start observing for URL changes
  if (document.documentElement) {
    urlObserver.observe(document, { subtree: true, childList: true });
  }
  
  // Also check URL periodically for SPAs that don't trigger events
  setInterval(updateCurrentUrl, 2000);
  
  // Keyboard shortcuts
  document.addEventListener('keydown', function(e) {
    // Ctrl+Shift+B to toggle recording
    if (e.ctrlKey && e.shiftKey && e.key === 'B') {
      e.preventDefault();
      toggleRecording();
    }
    // Ctrl+Shift+S to toggle selector mode
    else if (e.ctrlKey && e.shiftKey && e.key === 'S') {
      e.preventDefault();
      toggleSelectorMode();
    }
  });
  
  /**
   * Toggle selector mode for element selection
   */
  function toggleSelectorMode() {
    window.bcState.selectorMode = !window.bcState.selectorMode;
    updateIndicatorContent(window.bcState.indicator);
    
    if (window.bcState.selectorMode) {
      showToast('Selector mode: Click elements to capture');
      document.body.style.cursor = 'crosshair';
    } else {
      showToast('Selector mode disabled');
      document.body.style.cursor = '';
    }
  }
  
  // Screenshot functionality using browser APIs
  function captureScreenshot() {
    // Use browser's built-in screenshot capabilities
    // For content scripts, we'll rely on the background script to handle screenshots
    return new Promise((resolve) => {
      try {
        // Send message to background script to capture screenshot
        chrome.runtime.sendMessage({
          cmd: 'capture-screenshot',
          timestamp: Date.now()
        }, (response) => {
          if (chrome.runtime.lastError) {
            console.warn('Bug Capturer: Screenshot capture failed:', chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          if (response && response.success && response.screenshot) {
            resolve(response.screenshot);
          } else {
            console.warn('Bug Capturer: Invalid screenshot response:', response);
            resolve(null);
          }
        }).catch(err => {
          if (err.message && err.message.includes('Extension context invalidated')) {
            console.warn('Bug Capturer: Extension context invalidated during screenshot capture');
          } else {
            console.warn('Bug Capturer: Screenshot capture message failed:', err);
          }
          resolve(null);
        });
      } catch (error) {
        if (error.message && error.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated during screenshot capture');
        } else {
          console.warn('Bug Capturer: Screenshot capture not available:', error);
        }
        resolve(null);
      }
    });
  }

  // Enhanced screenshot functionality using html2canvas during pause
  async function captureScreenshotPause() {
    try {
      if (typeof html2canvas === 'undefined') {
        console.warn('html2canvas not available, using fallback method');
        // Fallback: return a basic screenshot info
        return null;
      }

      // Use html2canvas for better quality screenshots with smart cropping
      const canvas = await html2canvas(document.body, {
        useCORS: true,
        allowTaint: false,
        scale: 1.0,
        x: 0,
        y: 0,
        width: Math.min(window.innerWidth, document.documentElement.scrollWidth),
        height: Math.min(window.innerHeight, document.documentElement.scrollHeight),
        scrollX: 0,
        scrollY: 0,
        ignoreElements: (element) => {
          // Ignore extension UI elements
          return element.classList && (
            element.classList.contains('bc-root') ||
            element.classList.contains('bug-capturer-ui')
          );
        }
      });

      const screenshot = canvas.toDataURL('image/png', 0.9);
      
      console.log('Screenshot capture completed successfully');
      return screenshot;
    } catch (error) {
      console.error('Screenshot capture failed:', error);
      // Return null to indicate failure
      return null;
    }
  }
  
  /**
   * Generate comprehensive report of recorded steps
   */
  function generateReport() {
    return new Promise((resolve) => {
      const report = {
        sessionId: window.bcState.sessionId || Date.now().toString(),
        startTime: window.bcState.startTime,
        endTime: Date.now(),
        duration: Date.now() - window.bcState.startTime,
        url: window.location.href,
        userAgent: navigator.userAgent,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        steps: window.bcState.steps,
        summary: {
          totalSteps: window.bcState.steps.length,
          clickActions: window.bcState.steps.filter(s => s.meta?.action === 'click').length,
          inputActions: window.bcState.steps.filter(s => s.meta?.action === 'input').length,
          errors: window.bcState.steps.filter(s => s.type === 'error-detected' || s.meta?.level === 'error').length,
          performanceIssues: window.bcState.steps.filter(s => s.type === 'performance').length
        },
        generatedAt: new Date().toISOString()
      };
      
      resolve(report);
    });
  }
  
  // Initialize session ID for persistent tracking
  if (!window.bcState.sessionId) {
    window.bcState.sessionId = Date.now().toString() + Math.random().toString(36).substr(2, 9);
  }
  
  // Check if we need to restore state on page load
  setTimeout(() => {
    try {
      chrome.runtime.sendMessage({ cmd: 'get-persistent-state' })
        .then(response => {
        const persistentState = response?.state || response; // Handle both response formats
        if (persistentState && persistentState.isRecording && !window.bcState.recording) {
          // Auto-restore recording state if it was active
          window.bcState.recording = true;
          window.bcState.sessionId = persistentState.sessionId;
          window.bcState.startTime = persistentState.startTime;
          
          // Load existing steps from storage to continue session
          try {
            chrome.runtime.sendMessage({ cmd: 'get-steps' })
              .then(stepsResponse => {
              if (stepsResponse && stepsResponse.steps) {
                // Filter steps for current session to maintain continuity
                const sessionSteps = stepsResponse.steps.filter(step => 
                  step.sessionId === persistentState.sessionId || 
                  step.time >= persistentState.startTime
                );
                window.bcState.steps = sessionSteps;
                console.log(`Restored ${sessionSteps.length} steps from current session`);
              }
            })
            .catch(err => console.warn('Failed to load existing steps:', err));
          } catch (error) {
            if (error.message && error.message.includes('Extension context invalidated')) {
              console.warn('Bug Capturer: Extension context invalidated during steps retrieval');
            } else {
              console.error('Bug Capturer: Error getting steps:', error);
            }
          }
          
          if (!window.bcState.indicator) {
            createIndicator();
            setupErrorDetection();
          }
          
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'flex';
            updateIndicatorStatus();
          }
          
          console.log('Auto-restored recording state on page load with session continuity');
        }
      })
      .catch(err => {
        console.log('No persistent state to restore:', err);
      });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('Bug Capturer: Extension context invalidated during state restoration');
      } else {
        console.error('Bug Capturer: Error getting persistent state:', error);
      }
    }
  }, 500);
  
  // Extension initialization - now requires explicit user activation
  // Removed automatic startup - all functions now triggered by user action

  // Custom area selection state
  let isSelectingArea = false;
  let selectionStart = { x: 0, y: 0 };
  let selectionEnd = { x: 0, y: 0 };
  let selectionOverlay = null;
  let selectionRectangle = null;
  let selectionInfo = null;
  let selectionControls = null;
  
  /**
   * Console capture functionality
   */
  function setupConsoleCapture() {
    const originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info
    };
    
    // Override console methods to capture output
    console.log = function(...args) {
      originalConsole.log.apply(console, args);
      if (window.bcState.recording) {
        recordConsoleStep('log', args.join(' '));
      }
    };
    
    console.error = function(...args) {
      originalConsole.error.apply(console, args);
      if (window.bcState.recording) {
        recordConsoleStep('error', args.join(' '));
      }
    };
    
    console.warn = function(...args) {
      originalConsole.warn.apply(console, args);
      if (window.bcState.recording) {
        recordConsoleStep('warn', args.join(' '));
      }
    };
    
    console.info = function(...args) {
      originalConsole.info.apply(console, args);
      if (window.bcState.recording) {
        recordConsoleStep('info', args.join(' '));
      }
    };
    
    // Capture unhandled errors
    window.addEventListener('error', function(e) {
      if (window.bcState.recording) {
        recordConsoleStep('error', `${e.message} at ${e.filename}:${e.lineno}:${e.colno}`);
      }
    });
    
    // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', function(e) {
    if (window.bcState.recording) {
      recordConsoleStep('error', `Unhandled Promise Rejection: ${e.reason}`);
    }
  });
}

/**
 * Screenshot capture functionality
 */
function captureScreenshot(description = '') {
  return new Promise((resolve) => {
    // Use html2canvas if available, otherwise fallback to basic capture
    if (typeof html2canvas !== 'undefined') {
      html2canvas(document.body, {
        useCORS: true,
        allowTaint: true,
        scale: 1.0,
        x: 0,
        y: 0,
        width: Math.min(window.innerWidth, document.documentElement.scrollWidth),
        height: Math.min(window.innerHeight, document.documentElement.scrollHeight),
        scrollX: 0,
        scrollY: 0
      }).then(canvas => {
        const dataURL = canvas.toDataURL('image/png', 0.9);
        resolve({
          type: 'screenshot',
          description: description,
          dataURL: dataURL,
          timestamp: Date.now(),
          url: window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`
        });
      }).catch(() => {
        // Fallback to basic screenshot info
        resolve({
          type: 'screenshot',
          description: description,
          dataURL: null,
          timestamp: Date.now(),
          url: window.location.href,
          viewport: `${window.innerWidth}x${window.innerHeight}`,
          note: 'Screenshot capture failed - html2canvas not available'
        });
      });
    } else {
      // Basic screenshot info without actual image
      resolve({
        type: 'screenshot',
        description: description,
        dataURL: null,
        timestamp: Date.now(),
        url: window.location.href,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        note: 'Screenshot info only - html2canvas library required for image capture'
      });
    }
  });
}










/**
 * Auto-detect and capture error scenarios
 */
function setupErrorDetection() {
  // Common error message selectors
  const errorSelectors = [
    '[class*="error"]',
    '[class*="alert"]',
    '[class*="warning"]',
    '[id*="error"]',
    '[role="alert"]',
    '.error-message',
    '.alert-danger',
    '.validation-error'
  ];
  
  // Monitor for error messages
  const observer = new MutationObserver((mutations) => {
    if (!window.bcState.recording) return;
    
    mutations.forEach((mutation) => {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          // Check if the added node or its children contain error messages
          errorSelectors.forEach(selector => {
            try {
              const errorElements = node.matches && node.matches(selector) ? [node] : 
                                  node.querySelectorAll ? Array.from(node.querySelectorAll(selector)) : [];
              
              errorElements.forEach(errorEl => {
                const errorText = errorEl.textContent.trim();
                if (errorText && errorText.length > 3) {
                  // Record error without automatic screenshot
                  recordStep({
                    type: 'error-detected',
                    selector: getElementSelector(errorEl),
                    text: errorText,
                    time: Date.now(),
                    meta: {
                      action: 'error-detected',
                      timestamp: Date.now() - window.bcState.startTime,
                      errorType: 'ui-error',
                      element: errorEl.tagName.toLowerCase()
                    }
                  }).catch(console.error);
                }
              });
            } catch (e) {
              // Ignore selector errors
            }
          });
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true
  });
  
  // Store observer reference for cleanup
  window.bcState.errorObserver = observer;
}

/**
 * Test scenario documentation
 */
function recordTestScenario(scenario) {
  if (!window.bcState.recording) return;
  
  // Record test scenario without automatic screenshot
  recordStep({
    type: 'test-scenario',
    scenario: scenario,
    time: Date.now(),
    meta: {
      action: 'test-scenario',
      timestamp: Date.now() - window.bcState.startTime,
      scenarioType: scenario.type || 'manual'
    }
  }).catch(console.error);
}

/**
 * Enhanced step recording with screenshot support
 */
function recordStepWithScreenshot(stepData, takeScreenshot = false) {
  if (takeScreenshot) {
    captureScreenshot(stepData.description || `${stepData.type} action`).then(screenshot => {
      recordStep({
        ...stepData,
        screenshot: screenshot
      }).catch(console.error);
    });
  } else {
    recordStep(stepData).catch(console.error);
  }
}
  
  /**
   * Record console output as a step
   */
  function recordConsoleStep(level, message) {
    const step = {
      type: 'console',
      time: Date.now(),
      url: location.href,
      text: message.slice(0, 500), // Limit message length
      selector: 'console',
      sessionId: window.bcState.sessionId, // Add session ID for continuity
      meta: {
        action: 'console',
        level: level,
        timestamp: Date.now() - window.bcState.startTime
      }
    };
    
    // Store locally
    window.bcState.steps.push(step);
    
    // Send to background script
    try {
      chrome.runtime.sendMessage({
        cmd: 'store-step',
        step: step
      }).catch(err => {
        if (err.message && err.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated, stopping recording');
          window.bcState.recording = false;
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'none';
          }
        } else {
          console.warn('Failed to send console step to background:', err);
        }
      });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('Bug Capturer: Extension context invalidated, stopping recording');
        window.bcState.recording = false;
        if (window.bcState.indicator) {
          window.bcState.indicator.style.display = 'none';
        }
      } else {
        console.error('Bug Capturer: Error recording console step:', error);
      }
    }
  }
  
  // Setup console capture
  setupConsoleCapture();
  
  // Setup performance monitoring
  setupPerformanceMonitoring();
  
  // Setup keyboard shortcuts
  setupKeyboardShortcuts();
  
  /**
   * Performance monitoring functionality
   */
  function setupPerformanceMonitoring() {
    // Monitor page load performance
    window.addEventListener('load', function() {
      setTimeout(() => {
        if (window.bcState.recording && performance.timing) {
          const timing = performance.timing;
          const loadTime = timing.loadEventEnd - timing.navigationStart;
          const domReady = timing.domContentLoadedEventEnd - timing.navigationStart;
          
          recordPerformanceStep('page-load', {
            loadTime: loadTime,
            domReady: domReady,
            dns: timing.domainLookupEnd - timing.domainLookupStart,
            connect: timing.connectEnd - timing.connectStart,
            response: timing.responseEnd - timing.responseStart
          });
        }
      }, 100);
    });
    
    // Monitor resource loading
    if (window.PerformanceObserver) {
      const resourceObserver = new PerformanceObserver((list) => {
        if (!window.bcState.recording) return;
        
        list.getEntries().forEach(entry => {
          if (entry.duration > 1000) { // Only log slow resources (>1s)
            recordPerformanceStep('slow-resource', {
              name: entry.name,
              duration: Math.round(entry.duration),
              type: entry.initiatorType
            });
          }
        });
      });
      
      try {
        resourceObserver.observe({ entryTypes: ['resource'] });
      } catch (e) {
        console.warn('Performance observer not supported:', e);
      }
    }
    
    // Monitor long tasks
    if (window.PerformanceObserver) {
      const longTaskObserver = new PerformanceObserver((list) => {
        if (!window.bcState.recording) return;
        
        list.getEntries().forEach(entry => {
          recordPerformanceStep('long-task', {
            duration: Math.round(entry.duration),
            startTime: Math.round(entry.startTime)
          });
        });
      });
      
      try {
        longTaskObserver.observe({ entryTypes: ['longtask'] });
      } catch (e) {
        console.warn('Long task observer not supported:', e);
      }
    }
  }
  
  /**
   * Record performance metrics as a step
   */
  function recordPerformanceStep(type, data) {
    const step = {
      type: 'performance',
      time: Date.now(),
      url: location.href,
      text: formatPerformanceData(type, data),
      selector: 'performance',
      sessionId: window.bcState.sessionId, // Add session ID for continuity
      meta: {
        action: 'performance',
        performanceType: type,
        data: data,
        timestamp: Date.now() - window.bcState.startTime
      }
    };
    
    // Store locally
    window.bcState.steps.push(step);
    
    // Send to background script
    try {
      chrome.runtime.sendMessage({
        cmd: 'store-step',
        step: step
      }).catch(err => {
        if (err.message && err.message.includes('Extension context invalidated')) {
          console.warn('Bug Capturer: Extension context invalidated, stopping recording');
          window.bcState.recording = false;
          if (window.bcState.indicator) {
            window.bcState.indicator.style.display = 'none';
          }
        } else {
          console.warn('Failed to send performance step to background:', err);
        }
      });
    } catch (error) {
      if (error.message && error.message.includes('Extension context invalidated')) {
        console.warn('Bug Capturer: Extension context invalidated, stopping recording');
        window.bcState.recording = false;
        if (window.bcState.indicator) {
          window.bcState.indicator.style.display = 'none';
        }
      } else {
        console.error('Bug Capturer: Error recording performance step:', error);
      }
    }
  }
  
  /**
   * Format performance data for display
   */
  function formatPerformanceData(type, data) {
    switch (type) {
      case 'page-load':
        return `Page loaded in ${data.loadTime}ms (DOM: ${data.domReady}ms)`;
      case 'slow-resource':
        return `Slow ${data.type}: ${data.name.split('/').pop()} (${data.duration}ms)`;
      case 'long-task':
        return `Long task detected: ${data.duration}ms`;
      default:
        return `Performance: ${type}`;
    }
  }
  
  /**
   * Setup keyboard shortcuts
   */
  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', function(e) {
      // Ctrl+Shift+R: Toggle recording
      if (e.ctrlKey && e.shiftKey && e.key === 'R') {
        e.preventDefault();
        toggleRecording();
        return;
      }
      
      // Ctrl+Shift+S: Toggle selector mode
      if (e.ctrlKey && e.shiftKey && e.key === 'S') {
        e.preventDefault();
        toggleSelectorMode();
        return;
      }
      
      // Ctrl+Shift+C: Clear all steps
      if (e.ctrlKey && e.shiftKey && e.key === 'C') {
        e.preventDefault();
        clearAllSteps();
        return;
      }
      
      // Ctrl+Shift+E: Export data
      if (e.ctrlKey && e.shiftKey && e.key === 'E') {
        e.preventDefault();
        exportSteps();
        return;
      }
    });
  }
  
  /**
   * Toggle selector mode for element inspection
   */
  function toggleSelectorMode() {
    window.bcState.selectorMode = !window.bcState.selectorMode;
    
    if (window.bcState.selectorMode) {
      document.body.style.cursor = 'crosshair';
      showToast('🎯 Selector mode ON - Click elements to inspect', 'info');
      
      // Add temporary click handler for element selection
      document.addEventListener('click', handleSelectorClick, true);
    } else {
      document.body.style.cursor = '';
      showToast('🎯 Selector mode OFF', 'info');
      
      // Remove temporary click handler
      document.removeEventListener('click', handleSelectorClick, true);
    }
    
    updateIndicator();
  }
  
  /**
   * Handle clicks in selector mode
   */
  function handleSelectorClick(e) {
    if (!window.bcState.selectorMode) return;
    
    e.preventDefault();
    e.stopPropagation();
    
    const element = e.target;
    const selector = generateSelector(element);
    const elementInfo = {
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      className: element.className || '',
      textContent: element.textContent?.trim().substring(0, 50) || '',
      attributes: Array.from(element.attributes).map(attr => `${attr.name}="${attr.value}"`).join(' ')
    };
    
    // Record the element inspection
    if (window.bcState.recording) {
      recordStep('inspect', e, selector, `Inspected element: ${elementInfo.tagName}${elementInfo.id ? '#' + elementInfo.id : ''}${elementInfo.className ? '.' + elementInfo.className.split(' ')[0] : ''}`).catch(console.error);
    }
    
    // Show element info
    showToast(`🔍 ${selector}\n${elementInfo.textContent}`, 'info');
    
    // Exit selector mode after selection
    toggleSelectorMode();
  }
  
  /**
   * Clear all recorded steps
   */
  function clearAllSteps() {
    if (!window.bcState.recording) {
      showToast('❌ Recording not active', 'error');
      return;
    }
    
    window.bcState.steps = [];
    
    // Clear from background script
    chrome.runtime.sendMessage({
      cmd: 'clear-steps'
    }).catch(err => console.warn('Failed to clear steps in background:', err));
    
    showToast('🗑️ All steps cleared', 'success');
  }
  
  /**
   * Export steps data
   */
  function exportSteps() {
    if (window.bcState.steps.length === 0) {
      showToast('📄 No steps to export', 'warning');
      return;
    }
    
    // Send export command to background script
    chrome.runtime.sendMessage({
      cmd: 'export-steps'
    }).catch(err => console.warn('Failed to export steps:', err));
    
    showToast('📄 Export initiated', 'success');
  }
  
  /**
   * Start custom area selection on the website
   */
  function startCustomAreaSelection() {
    if (!window.bcState.recording) {
      showToast('Recording must be active to capture custom area');
      return;
    }

    // Close any existing selection
    if (selectionOverlay) {
      cancelAreaSelection();
    }

    // Create selection overlay
    createAreaSelectionOverlay();
    
    showToast('Click and drag to select area for screenshot');
  }

  /**
   * Create the area selection overlay on the website
   */
  function createAreaSelectionOverlay() {
    // Create overlay
    selectionOverlay = document.createElement('div');
    selectionOverlay.setAttribute('data-bc-ignore', 'true');
    selectionOverlay.className = 'bc-area-selection-overlay';
    selectionOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.3);
      z-index: 2147483640;
      cursor: crosshair;
      user-select: none;
    `;
    
    // Create rectangle
    selectionRectangle = document.createElement('div');
    selectionRectangle.className = 'bc-selection-rectangle';
    selectionRectangle.style.cssText = `
      position: absolute;
      border: 2px solid #3b82f6;
      background: rgba(59, 130, 246, 0.1);
      display: none;
      pointer-events: none;
    `;
    
    // Create info display
    selectionInfo = document.createElement('div');
    selectionInfo.className = 'bc-selection-info';
    selectionInfo.style.cssText = `
      position: fixed;
      top: 20px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(0, 0, 0, 0.8);
      color: white;
      padding: 8px 16px;
      border-radius: 6px;
      font-size: 14px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      z-index: 2147483641;
      pointer-events: none;
    `;
    selectionInfo.textContent = 'Click and drag to select area';
    
    // Create controls
    selectionControls = document.createElement('div');
    selectionControls.className = 'bc-selection-controls';
    selectionControls.style.cssText = `
      position: fixed;
      bottom: 20px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 12px;
      z-index: 2147483641;
    `;
    selectionControls.innerHTML = `
      <button class="bc-selection-btn bc-cancel-btn" style="
        background: #6b7280;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      ">Cancel</button>
      <button class="bc-selection-btn bc-capture-btn" id="bc-capture-selected-btn" disabled style="
        background: #3b82f6;
        color: white;
        border: none;
        padding: 8px 16px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 14px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      ">Capture Area</button>
    `;
    
    // Add to overlay
    selectionOverlay.appendChild(selectionRectangle);
    selectionOverlay.appendChild(selectionInfo);
    selectionOverlay.appendChild(selectionControls);
    
    // Add to document
    document.documentElement.appendChild(selectionOverlay);
    
    // Add event listeners
    selectionOverlay.addEventListener('mousedown', startAreaSelection);
    selectionOverlay.addEventListener('mousemove', updateAreaSelection);
    selectionOverlay.addEventListener('mouseup', endAreaSelection);
    selectionOverlay.addEventListener('click', (e) => e.stopPropagation());
    
    // Add control button listeners
    selectionControls.querySelector('.bc-cancel-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      cancelAreaSelection();
    });
    
    selectionControls.querySelector('.bc-capture-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      captureSelectedArea();
    });
    
    isSelectingArea = false;
  }

  /**
   * Start area selection on mouse down
   */
  function startAreaSelection(e) {
    if (e.target !== selectionOverlay) return;
    
    isSelectingArea = true;
    // Account for page scroll position and ensure coordinates are within bounds
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const clientX = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const clientY = Math.max(0, Math.min(e.clientY, window.innerHeight));
    
    selectionStart.x = clientX + scrollX;
    selectionStart.y = clientY + scrollY;
    selectionEnd.x = clientX + scrollX;
    selectionEnd.y = clientY + scrollY;
    
    selectionRectangle.style.display = 'block';
    updateAreaSelectionRectangle();
  }

  /**
   * Update area selection on mouse move
   */
  function updateAreaSelection(e) {
    if (!isSelectingArea) return;
    
    // Account for page scroll position and ensure coordinates are within bounds
    const scrollX = window.scrollX || 0;
    const scrollY = window.scrollY || 0;
    const clientX = Math.max(0, Math.min(e.clientX, window.innerWidth));
    const clientY = Math.max(0, Math.min(e.clientY, window.innerHeight));
    
    selectionEnd.x = clientX + scrollX;
    selectionEnd.y = clientY + scrollY;
    
    updateAreaSelectionRectangle();
  }

  /**
   * End area selection on mouse up
   */
  function endAreaSelection(e) {
    if (!isSelectingArea) return;
    
    isSelectingArea = false;
    
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);
    
    if (width > 10 && height > 10) {
      // Enable capture button
      const captureBtn = document.getElementById('bc-capture-selected-btn');
      if (captureBtn) {
        captureBtn.disabled = false;
      }
    }
  }

  /**
   * Update the area selection rectangle visual
   */
  function updateAreaSelectionRectangle() {
    // Calculate viewport coordinates for visual rectangle
    const viewportLeft = Math.min(selectionStart.x - window.scrollX, selectionEnd.x - window.scrollX);
    const viewportTop = Math.min(selectionStart.y - window.scrollY, selectionEnd.y - window.scrollY);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);
    
    selectionRectangle.style.left = viewportLeft + 'px';
    selectionRectangle.style.top = viewportTop + 'px';
    selectionRectangle.style.width = width + 'px';
    selectionRectangle.style.height = height + 'px';
    
    // Update info
    selectionInfo.textContent = `Selection: ${width} × ${height}px`;
  }

  /**
   * Cancel area selection
   */
  function cancelAreaSelection() {
    if (selectionOverlay) {
      selectionOverlay.remove();
      selectionOverlay = null;
      selectionRectangle = null;
      selectionInfo = null;
      selectionControls = null;
    }
    
    showToast('Area selection cancelled');
  }

  /**
   * Capture the selected area
   */
  async function captureSelectedArea() {
    if (!selectionOverlay) return;
    
    const left = Math.min(selectionStart.x, selectionEnd.x);
    const top = Math.min(selectionStart.y, selectionEnd.y);
    const width = Math.abs(selectionEnd.x - selectionStart.x);
    const height = Math.abs(selectionEnd.y - selectionStart.y);
    
    // Validate minimum selection size
    if (width < 10 || height < 10) {
      showToast('Please select a larger area (minimum 10x10 pixels)');
      return;
    }
    
    // Validate maximum selection size
    if (width > 5000 || height > 5000) {
      showToast('Selected area is too large (maximum 5000x5000 pixels)');
      return;
    }
    
    // Debug logging
    console.log('Custom area selection coordinates:', {
      selectionStart: selectionStart,
      selectionEnd: selectionEnd,
      finalArea: { x: left, y: top, width: width, height: height },
      scrollPosition: { x: window.scrollX, y: window.scrollY },
      viewport: { width: window.innerWidth, height: window.innerHeight }
    });
    
    // Remove overlay
    cancelAreaSelection();
    
    try {
      // Send message to background script to capture custom area
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          cmd: 'capture-screenshot-custom',
          area: {
            x: left,
            y: top,
            width: width,
            height: height
          },
          timestamp: Date.now()
        }, (response) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });

      if (response && response.success) {
        const screenshotData = response.screenshot || response;
        const dataURL = screenshotData.dataURL || screenshotData.screenshot;
        
        if (dataURL) {
          // Send to background script for storage and popup notification
          // (Background script already stores as step via capture-screenshot-custom command)
          try {
            const screenshotData = {
              id: Date.now(),
              dataURL: dataURL,
              type: 'custom',
              timestamp: Date.now(),
              url: window.location.href,
              viewport: `${width}x${height}`,
              area: { x: left, y: top, width: width, height: height },
              description: `Custom area screenshot (${width}x${height})`
            };
            
            console.log('Sending custom screenshot to background script:', screenshotData);
            
            chrome.runtime.sendMessage({
              cmd: 'custom-screenshot-captured',
              screenshot: screenshotData
            }, (response) => {
              if (chrome.runtime.lastError) {
                console.error('Error sending custom screenshot:', chrome.runtime.lastError);
              } else {
                console.log('Custom screenshot sent successfully, response:', response);
              }
            });
          } catch (error) {
            console.warn('Failed to send screenshot to background script:', error);
          }
          
          showToast('Custom area screenshot captured successfully!');
        } else {
          showToast('Failed to capture custom area - no data received');
        }
      } else {
        const errorMsg = response?.error || 'Unknown error';
        showToast(`Failed to capture custom area: ${errorMsg}`);
      }
    } catch (error) {
      console.error('Custom area capture error:', error);
      showToast('Custom area capture failed: ' + error.message);
    }
  }

  console.log('Bug Capturer Extension: Content script loaded');
})();