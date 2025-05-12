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

// Custom SMTP check function with retries and multiple ports
async function customSmtpCheck(email, mxRecords) {
  if (!mxRecords || !Array.isArray(mxRecords) || mxRecords.length === 0) {
    return { valid: false, reason: 'No valid MX records provided for SMTP check' };
  }

  const [user, domain] = email.split('@');
  const ports = [25, 587]; // Try SMTP and submission ports
  const maxRetries = 3;

  // Sort MX records by priority
  const sortedMxRecords = mxRecords.sort((a, b) => a.priority - b.priority);

  for (const mx of sortedMxRecords) {
    for (const port of ports) {
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`Attempting SMTP check for ${email} on ${mx.exchange}:${port} (Attempt ${attempt}/${maxRetries})`);
        const result = await trySmtpConnection(email, mx.exchange, port);
        if (result.valid === true) {
          return result; // Success
        }
        if (result.valid === false) {
          return result; // Definitive failure (e.g., user unknown)
        }
        console.log(`SMTP check inconclusive on ${mx.exchange}:${port}: ${result.reason}`);
      }
    }
  }

  return { valid: false, reason: 'All SMTP checks failed after retries' };
}

// Helper function for a single SMTP connection attempt
async function trySmtpConnection(email, mxHost, port) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let timeout;
    let maxConnectionTime;

    socket.setTimeout(10000); // 10-second timeout for socket operations

    socket.on('connect', () => {
      console.log(`Connected to SMTP server ${mxHost}:${port}`);
      socket.write('HELO localhost\r\n');
      socket.write(`MAIL FROM:<test@example.com>\r\n`);
      socket.write(`RCPT TO:<${email}>\r\n`);
    });

    socket.on('data', (data) => {
      const response = data.toString();
      console.log(`SMTP response from ${mxHost}:${port}: ${response.trim()}`);
      if (response.includes('250') || response.includes('220')) {
        socket.destroy();
        resolve({ valid: true, reason: 'SMTP connection successful' });
      } else if (response.includes('550') || response.includes('554')) {
        socket.destroy();
        resolve({ valid: false, reason: 'SMTP rejected: user unknown or mailbox unavailable' });
      }
    });

    socket.on('timeout', () => {
      console.log(`SMTP timeout on ${mxHost}:${port}`);
      socket.destroy();
      resolve({ valid: null, reason: 'SMTP timeout' });
    });

    socket.on('error', (error) => {
      console.log(`SMTP error on ${mxHost}:${port}: ${error.message}`);
      socket.destroy();
      resolve({ valid: null, reason: `SMTP connection failed: ${error.message}` });
    });

    socket.on('close', () => {
      clearTimeout(timeout);
      clearTimeout(maxConnectionTime);
    });

    socket.connect(port, mxHost);

    // Set a maximum connection time to prevent hanging
    maxConnectionTime = setTimeout(() => {
      console.log(`Maximum connection time exceeded on ${mxHost}:${port}`);
      socket.destroy();
      resolve({ valid: null, reason: 'Maximum connection time exceeded' });
    }, 10000);

    // Ensure timeout is cleared if connection closes early
    timeout = setTimeout(() => {
      console.log(`SMTP timeout on ${mxHost}:${port}`);
      socket.destroy();
      resolve({ valid: null, reason: 'SMTP timeout' });
    }, 10000);
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
      validateSMTP: false // Disable built-in SMTP
    });

    // Log deep-email-validator MX data for debugging
    console.log('Deep Validator MX for', email, ':', JSON.stringify(result.validators.mx.data, null, 2));

    // Perform manual MX lookup
    const [, domain] = email.split('@');
    const mxRecords = await getMxRecords(domain);
    console.log('Manual MX Records for', email, ':', JSON.stringify(mxRecords, null, 2));

    // Custom SMTP check (mandatory)
    const customSmtpResult = await customSmtpCheck(email, mxRecords);

    // Determine deliverability status (SMTP check is mandatory)
    const isValid = customSmtpResult.valid === true;
    const status = isValid ? 'deliverable' : 'undeliverable';
    const willBounce = !isValid;
    const reason = isValid ? 'Email is valid' : customSmtpResult.reason;

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
        reason: reason,
        additionalInfo: customSmtpResult.valid === false
          ? `Custom SMTP check failed: ${customSmtpResult.reason}`
          : customSmtpResult.valid === null
          ? `SMTP check inconclusive: ${customSmtpResult.reason}`
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
