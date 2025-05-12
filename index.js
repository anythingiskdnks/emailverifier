const express = require('express');
const { isEmail } = require('validator');
const deepEmailValidator = require('deep-email-validator');
const net = require('net');
const dns = require('dns').promises;
const app = express();
const port = process.env.PORT || 3000;

// Middleware to parse JSON bodies
app.use(express.json());

// Custom MX record lookup
async function getMxRecords(domain) {
  try {
    const records = await dns.resolveMx(domain);
    return records.map(record => ({ exchange: record.exchange, priority: record.priority }));
  } catch (error) {
    console.error(`MX lookup failed for ${domain}:`, error);
    return [];
  }
}

// Custom SMTP check function with retry on multiple MX records
async function customSmtpCheck(email, mxRecords) {
  if (!mxRecords || !Array.isArray(mxRecords) || mxRecords.length === 0) {
    return { valid: null, reason: 'No valid MX records provided for SMTP check' };
  }

  const [user, domain] = email.split('@');
  let lastError = null;

  // Try each MX record in order of priority
  for (const mx of mxRecords.sort((a, b) => a.priority - b.priority)) {
    console.log(`Attempting SMTP check for ${email} on ${mx.exchange}`);
    const result = await trySmtpConnection(email, mx.exchange);
    if (result.valid !== null) {
      return result; // Return on success or definitive failure
    }
    lastError = result.reason;
  }

  return { valid: null, reason: lastError || 'All SMTP checks failed' };
}

// Helper function for a single SMTP connection attempt
async function trySmtpConnection(email, mxHost) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let timeout;

    socket.setTimeout(8000); // 8-second timeout

    socket.on('connect', () => {
      console.log(`Connected to SMTP server ${mxHost}`);
      socket.write('HELO localhost\r\n');
      socket.write(`MAIL FROM:<test@example.com>\r\n`);
      socket.write(`RCPT TO:<${email}>\r\n`);
    });

    socket.on('data', (data) => {
      const response = data.toString();
      console.log(`SMTP response from ${mxHost}: ${response.trim()}`);
      if (response.includes('250') || response.includes('220')) {
        socket.destroy();
        resolve({ valid: true, reason: 'SMTP connection successful' });
      } else if (response.includes('550') || response.includes('554')) {
        socket.destroy();
        resolve({ valid: false, reason: 'SMTP rejected: user unknown or mailbox unavailable' });
      }
    });

    socket.on('timeout', () => {
      console.log(`SMTP timeout on ${mxHost}`);
      socket.destroy();
      resolve({ valid: null, reason: 'SMTP timeout' });
    });

    socket.on('error', (error) => {
      console.log(`SMTP error on ${mxHost}: ${error.message}`);
      socket.destroy();
      resolve({ valid: null, reason: `SMTP connection failed: ${error.message}` });
    });

    socket.connect(25, mxHost);
    timeout = setTimeout(() => {
      socket.destroy();
      resolve({ valid: null, reason: 'SMTP timeout' });
    }, 8000);

    socket.on('close', () => {
      clearTimeout(timeout);
    });
  });
}

// Email verification endpoint
app.post('/verify-email', async (req, res) => {
  try {
    const { email } = req.body;

    // Basic email format validation
    if (!email || !isEmail(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Perform deep email validation without SMTP
    const result = await deepEmailValidator.validate({
      email,
      validateRegex: true,
      validateMx: true,
      validateTypo: true,
      validateDisposable: true,
      validateSMTP: false // Disable built-in SMTP due to unreliability
    });

    // Log deep-email-validator MX data for debugging
    console.log('Deep Validator MX for', email, ':', JSON.stringify(result.validators.mx.data, null, 2));

    // Perform manual MX lookup
    const [, domain] = email.split('@');
    const mxRecords = await getMxRecords(domain);
    console.log('Manual MX Records for', email, ':', JSON.stringify(mxRecords, null, 2));

    // Custom SMTP check
    let customSmtpResult = { valid: null, reason: 'SMTP check skipped' };
    if (mxRecords.length > 0) {
      customSmtpResult = await customSmtpCheck(email, mxRecords);
    } else if (!result.validators.mx.valid) {
      customSmtpResult = { valid: false, reason: 'No MX records found by validator' };
    }

    // Determine deliverability status
    const isValid = result.valid && (customSmtpResult.valid === true || customSmtpResult.valid === null || (result.validators.mx.valid && mxRecords.length === 0));
    const status = isValid ? 'deliverable' : 'undeliverable';
    const willBounce = !isValid;
    const reason = !isValid
      ? (customSmtpResult.reason !== 'SMTP check skipped' ? customSmtpResult.reason : result.reason)
      : 'Email is valid';

    res.json({
      email,
      status,
      willBounce,
      details: {
        validFormat: result.validators.regex.valid,
        validMx: result.validators.mx.valid,
        validTypo: result.validators.typo.valid,
        isDisposable: !result.validators.disposable.valid,
        validSmtp: customSmtpResult.valid,
        reason: reason || 'Email is valid',
        additionalInfo: customSmtpResult.valid === false
          ? `Custom SMTP check failed: ${customSmtpResult.reason}`
          : customSmtpResult.valid === null && result.validators.mx.valid
          ? 'SMTP check inconclusive, but validator confirms MX records exist'
          : ''
      }
    });
  } catch (error) {
    console.error('Error verifying email:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
