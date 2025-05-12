from flask import Flask, request, jsonify
import re
import dns.resolver
import socket

app = Flask(__name__)

EMAIL_REGEX = r"(^[a-zA-Z0-9_.+-]+@[a-zA-Z0-9-]+\.[a-zA-Z0-9-.]+$)"

# Function to check if the email format is valid
def is_valid_format(email):
    return re.match(EMAIL_REGEX, email) is not None

# Function to check if the domain has MX (Mail Exchange) records
def has_mx_record(domain):
    try:
        records = dns.resolver.resolve(domain, 'MX')
        return len(records) > 0
    except:
        return False

# Function to check if the email is deliverable
def smtp_check(email):
    domain = email.split('@')[1]
    try:
        mx_records = dns.resolver.resolve(domain, 'MX')
        mx_record = str(mx_records[0].exchange)
        server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        server.settimeout(10)

        # Try connecting on multiple ports for flexibility
        for port in [25, 587, 465]:
            try:
                server.connect((mx_record, port))
                server.send(b'HELO test.com\r\n')
                server.send(f'MAIL FROM:<verify@test.com>\r\n'.encode())
                server.send(f'RCPT TO:<{email}>\r\n'.encode())
                response = server.recv(1024)
                server.close()

                # Check SMTP response codes
                if b'250' in response:
                    return "Deliverable"
                elif b'550' in response:
                    return "Permanent failure - likely bounced"
                elif b'451' in response or b'452' in response:
                    return "Temporary failure - retryable"
                else:
                    return "Unknown response"
            except Exception as e:
                # Log the error to debug further
                print(f"Failed to connect on port {port}: {str(e)}")
                continue
        return "SMTP check failed - no successful connection"
    except Exception as e:
        return f"SMTP check failed with error: {str(e)}"

@app.route('/verify', methods=['GET'])
def verify_email():
    email = request.args.get('email', '')
    if not email:
        return jsonify({'error': 'Email is required'}), 400

    format_valid = is_valid_format(email)
    domain_valid = has_mx_record(email.split('@')[1]) if format_valid else False
    smtp_status = smtp_check(email) if domain_valid else "Invalid domain or no MX records"

    return jsonify({
        'email': email,
        'format_valid': format_valid,
        'domain_has_mx': domain_valid,
        'smtp_status': smtp_status
    })

if __name__ == '__main__':
    print("Starting app...")
    app.run(host='0.0.0.0', port=5000)
