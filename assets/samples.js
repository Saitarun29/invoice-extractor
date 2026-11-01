// Built-in sample documents. Fictional vendors, numbers and tax IDs.
export const SAMPLES = [
  {
    id: 'gst',
    label: 'Indian GST invoice',
    tone: 'ok',
    expect: 'Auto-approves',
    note: 'Intra-state supply in Telangana: CGST 9% + SGST 9%. Run it a second time to see the duplicate check send it to review.',
    text: `SHARMA OFFICE SUPPLIES PVT LTD
Plot 14, IDA Uppal, Hyderabad, Telangana 500039
GSTIN: 36AABCS4821K1Z3

TAX INVOICE

Invoice No: SOS/2026-27/0418
Invoice Date: 14/10/2026
Due Date: 13/11/2026
Payment Terms: Net 30

Bill To:
Kestrel Logistics Pvt Ltd
Hitech City, Hyderabad, Telangana 500081
GSTIN: 36AAGCK7315M1ZQ

#  Description                      HSN    Qty   Rate        Amount
1  A4 copier paper, 75 gsm (ream)   4802    20     285.00     5,700.00
2  HP 682 ink cartridge             8443     6   1,150.00     6,900.00
3  Ergonomic office chair           9401     2   7,450.00    14,900.00

Taxable Value                                               27,500.00
CGST @ 9%                                                    2,475.00
SGST @ 9%                                                    2,475.00
Grand Total (INR)                                           32,450.00

Amount in words: Rupees Thirty-Two Thousand Four Hundred Fifty Only
Bank: HDFC Bank, A/c 50200012345678, IFSC HDFC0001234`,
  },
  {
    id: 'saas',
    label: 'US SaaS invoice',
    tone: 'ok',
    expect: 'Auto-approves',
    note: 'Seat-based plan plus metered overage and state sales tax, month-first dates.',
    text: `Northwind Cloud, Inc.
500 Howard Street, Suite 300, San Francisco, CA 94105
EIN 84-3920175

INVOICE

Invoice #: INV-2026-10873
Issue date: October 1, 2026
Due date: October 31, 2026
Terms: Net 30

Bill to: Brightline Health LLC, 1201 3rd Ave, Seattle, WA 98101

Description                         Qty      Unit price      Amount
Team plan, seats (Oct 2026)          25         $24.00     $600.00
API overage, per 1k calls          1200          $0.40     $480.00
Priority support                      1        $150.00     $150.00

Subtotal                                                 $1,230.00
Sales tax (WA 10.25%)                                      $126.08
Total due (USD)                                          $1,356.08

Pay by ACH or card at billing.northwind.example/pay`,
  },
  {
    id: 'receipt',
    label: 'Scanned receipt',
    tone: 'warn',
    expect: 'Review: low confidence',
    note: 'OCR noise: letter O where zeros belong, a two-digit year, no due date. The maths holds, but confidence drops below 0.85.',
    text: `   HYDERABAD CHAI P0INT & BAKERY
  Shop 7, Ameerpet X Rd, Hyd-16
 GSTIN 36AFZPC5512R1ZK
--------------------------------
 Bill No : 2231        Dt: 28/1O/26
 Table: T4        Cashier: Ravi
--------------------------------
 Item              Qty  Rate    Amt
 Masala Chai        4   30.00  120.00
 Veg Puff           3   25.0O   75.00
 Osmania Bisc 200g  1   85.00   85.00
 Water Btl          2   20.00   4O.00
--------------------------------
 Sub Total                32O.00
 CGST 2.5%                  8.00
 SGST 2.5%                  8.00
 TOTAL Rs.                336.00
--------------------------------
 PAID - UPI   Ref 6281 5530 1124
   Thank you. Visit again`,
  },
  {
    id: 'suspicious',
    label: 'Suspicious invoice',
    tone: 'bad',
    expect: 'Review: checks fail',
    note: 'Lines add to 48,000 but the taxable value says 52,000, the due date is before the issue date, and the bank details changed.',
    text: `APEX FACILITY SERVICES
22 Industrial Estate, Guindy, Chennai 600032
GSTIN: 33AAJFA9120C1Z8

TAX INVOICE

Invoice No: AFS-0091
Invoice Date: 20/10/2026
Due Date: 05/10/2026
Payment Terms: Immediate

Bill To: Kestrel Logistics Pvt Ltd, Hyderabad

Description                       Qty   Rate         Amount
Deep cleaning, warehouse B          1   18,000.00    18,000.00
Pest control, quarterly             1   12,000.00    12,000.00
Security staff, Oct (2 guards)      2    9,000.00    18,000.00

Taxable Value                                        52,000.00
IGST @ 18%                                            9,360.00
Total Amount (INR)                                   61,360.00

NOTE: Our bank details have changed. Please pay to
ICICI Bank A/c 001105029988, IFSC ICIC0000011 from this invoice onwards.`,
  },
];
