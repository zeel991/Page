"""A small HTTP front end: POST /invoices with an order, get its total back."""

import json
from http.server import BaseHTTPRequestHandler, HTTPServer

from .service import invoice_total_cents


class InvoiceHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("content-length", "0"))
        order = json.loads(self.rfile.read(length) or b"{}")
        total = invoice_total_cents(order)
        body = json.dumps({"total_cents": total}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(body)


def main():
    HTTPServer(("0.0.0.0", 8080), InvoiceHandler).serve_forever()


if __name__ == "__main__":
    main()
