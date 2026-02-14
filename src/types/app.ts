export interface Connection {
  id: string;
  name: string;
  host: string;
  port: string;
  username: string;
  password?: string;
  database: string;
  db_type: "postgres" | "clickhouse";
  active?: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  query: string;
  active?: boolean;
}

export interface SavedResult {
  id: string;
  name: string;
  records: any[];
  query: string;
  active?: boolean;
}

export const emptyConnection: Connection = {
  id: "",
  name: "",
  host: "",
  port: "",
  username: "",
  password: "",
  database: "",
  db_type: "clickhouse",
};
